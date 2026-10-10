import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { config, DATA_DIR } from "../config.js";
import { fetcher } from "../http/fetcher.js";
import { logger } from "../logger.js";
import { getSettings, updateSettings } from "../settings.js";
import { sleep } from "../util.js";

/**
 * Login without copying cookies by hand: open a real Chrome window with a
 * dedicated profile, let the user sign in to B2B-Center however they like
 * (password, ЭЦП, captcha), then take the site's cookies from the browser.
 * The parser never sees the password.
 *
 * The profile is kept in data/browser-profile, so with «Запомнить меня» the
 * site can restore the session later without a window (refreshSessionFromProfile).
 */
const PROFILE_DIR = path.join(DATA_DIR, "browser-profile");

/** The site's own login page (OpenID provider); returns to the site after login. */
function loginUrl(): string {
  const p = new URLSearchParams({
    client_id: config.oidcClientId,
    redirect_uri: `${config.baseUrl}/app/next/silent-auth/`,
    response_type: "code",
    scope: "openid",
    state: "login",
    nonce: "login",
  });
  return `${config.baseUrl}/auth/openid/authorize/?${p}`;
}

/** Chrome locks a profile: only one window (login or background refresh) at a time. */
let profileBusy = false;

async function withProfile<T>(fn: () => Promise<T>): Promise<T> {
  if (profileBusy) throw new Error("браузер входа уже открыт");
  profileBusy = true;
  try {
    return await fn();
  } finally {
    profileBusy = false;
  }
}

async function launch(headless: boolean): Promise<BrowserContext> {
  const opts = { headless, viewport: null, args: ["--no-first-run", "--no-default-browser-check"] };
  try {
    // The user's installed Google Chrome: nothing to download.
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: "chrome" });
  } catch (err) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, opts);
    } catch {
      throw new Error(`Не удалось запустить Google Chrome (${(err as Error).message.split("\n")[0]}). Установите Chrome.`);
    }
  }
}

/** Cookie header with the B2B-Center cookies currently held by the browser. */
async function siteCookie(ctx: BrowserContext): Promise<string> {
  const cookies = await ctx.cookies(config.baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Save a verified cookie as the parser's session. */
function adopt(cookie: string, userId: string): void {
  updateSettings({ authCookie: cookie });
  logger.info(`Вход выполнен (user_id ${userId}), cookie сохранена.`);
}

/**
 * Open a Chrome window on the login page and wait until the site recognises
 * the user, then save the cookies and close the window.
 */
export function loginViaBrowser(opts: { timeoutMs?: number } = {}): Promise<{ userId: string }> {
  return withProfile(() => interactiveLogin(opts.timeoutMs ?? 10 * 60_000));
}

async function interactiveLogin(timeoutMs: number): Promise<{ userId: string }> {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await launch(false);
  let closed = false;
  ctx.on("close", () => (closed = true));
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(loginUrl()).catch(() => undefined);
    logger.info("Открыто окно входа B2B-Center. Войдите в личный кабинет — окно закроется само.");

    const deadline = Date.now() + timeoutMs;
    let lastTried = "";
    while (Date.now() < deadline) {
      await sleep(2000);
      if (closed) throw new Error("окно браузера закрыто до входа");
      const cookie = await siteCookie(ctx);
      if (!cookie || cookie === lastTried) continue;
      lastTried = cookie;
      const userId = await fetcher.userIdForCookie(cookie).catch(() => null);
      if (userId) {
        adopt(cookie, userId);
        return { userId };
      }
    }
    throw new Error("время ожидания входа истекло (10 мин)");
  } finally {
    if (!closed) await ctx.close().catch(() => undefined);
  }
}

export function hasBrowserProfile(): boolean {
  return fs.existsSync(PROFILE_DIR) && fs.readdirSync(PROFILE_DIR).length > 0;
}

/**
 * Try to restore the session from the saved browser profile without showing
 * a window (works when the site remembered the login). Returns the user id,
 * or null if a manual login is needed.
 */
export async function refreshSessionFromProfile(): Promise<string | null> {
  if (!hasBrowserProfile() || profileBusy) return null;
  return withProfile(silentRefresh);
}

async function silentRefresh(): Promise<string | null> {
  const ctx = await launch(true);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    // If the site remembered the user, the login page redirects straight back.
    await page.goto(loginUrl()).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const cookie = await siteCookie(ctx);
    if (!cookie || cookie === getSettings().authCookie.trim()) return null;
    const userId = await fetcher.userIdForCookie(cookie).catch(() => null);
    if (userId) adopt(cookie, userId);
    return userId;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
