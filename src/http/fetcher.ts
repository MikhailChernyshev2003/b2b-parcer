import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getSettings } from "../settings.js";

/**
 * Polite HTTP client for b2b-center.
 *
 * - Sends a browser-like User-Agent.
 * - Maintains a simple in-memory cookie jar (captures Set-Cookie, replays Cookie).
 * - Merges the configured authenticated session cookie (runtime settings) on every
 *   request, which unlocks tender documentation and deep pagination.
 * - Retries transient failures (timeouts, 5xx, 429) with backoff.
 * - Throttles to one request per requestDelayMs to avoid server throttling.
 */
class Fetcher {
  private client: AxiosInstance;
  private jar = new Map<string, string>();
  private lastRequestAt = 0;

  constructor() {
    this.client = axios.create({
      timeout: config.requestTimeoutMs,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        "User-Agent": config.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
      },
    });
  }

  private mergeSetCookie(setCookie: string[] | undefined): void {
    if (!setCookie) return;
    for (const raw of setCookie) {
      const pair = raw.split(";")[0];
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /** Build the Cookie header: jar cookies overlaid with the auth cookie (auth wins). */
  private cookieHeader(): string {
    const merged = new Map(this.jar);
    const auth = getSettings().authCookie.trim();
    if (auth) {
      for (const part of auth.split(";")) {
        const eq = part.indexOf("=");
        if (eq <= 0) continue;
        merged.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
      }
    }
    return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private async throttle(): Promise<void> {
    const wait = config.requestDelayMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  async getText(url: string): Promise<string> {
    return (await this.request(url, "text")).data as string;
  }

  async getBuffer(url: string): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await this.request(url, "arraybuffer");
    return {
      buffer: Buffer.from(res.data as ArrayBuffer),
      contentType: String(res.headers["content-type"] || ""),
    };
  }

  /**
   * Verify whether the current cookie authenticates a real user.
   * Uses /market/ rather than the home page: the latter is behind an anti-bot
   * captcha for non-browser clients, while /market/ renders the real (and,
   * when authorized, logged-in) page with GlobalJsConfig.user_id and a "logout" link.
   */
  async checkAuth(): Promise<{ authenticated: boolean; userId: string | null }> {
    const html = await this.getText(`${config.baseUrl}/market/`);
    const m = html.match(/"user_id"\s*:\s*(\d+|null|"\d+")/);
    const userId = m && m[1] !== "null" ? m[1]!.replace(/"/g, "") : null;
    const hasLoggedInMarkers = /logout|Личный кабинет/.test(html);
    return { authenticated: Boolean(userId) || hasLoggedInMarkers, userId };
  }

  private async request(url: string, responseType: "text" | "arraybuffer"): Promise<AxiosResponse> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      await this.throttle();
      try {
        const cookie = this.cookieHeader();
        const res = await this.client.get(url, {
          responseType,
          headers: cookie ? { Cookie: cookie } : {},
        });
        this.mergeSetCookie(res.headers["set-cookie"] as string[] | undefined);
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (res.status >= 400) logger.warn(`GET ${url} -> HTTP ${res.status}`);
        return res;
      } catch (err) {
        lastErr = err;
        const backoff = Math.min(15000, 1000 * 2 ** (attempt - 1));
        logger.warn(
          `GET ${url} failed (attempt ${attempt}/${config.maxRetries}): ${(err as Error).message}. Retry in ${backoff}ms`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw new Error(`GET ${url} failed after ${config.maxRetries} attempts: ${(lastErr as Error)?.message}`);
  }
}

export const fetcher = new Fetcher();
