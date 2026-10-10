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

  async getText(url: string, opts: { allowStatus?: number[] } = {}): Promise<string> {
    return (await this.request(url, "text", opts)).data as string;
  }

  /** GET a JSON endpoint. Throws if the body is not JSON (e.g. an HTML error/captcha page). */
  async getJson<T = unknown>(url: string): Promise<T> {
    const res = await this.request(url, "text", { headers: { Accept: "application/json" } });
    return parseJsonBody<T>(url, res.data as string);
  }

  /** POST a JSON body to a JSON endpoint (b2b-center openapi). */
  async postJson<T = unknown>(url: string, body: unknown): Promise<T> {
    const res = await this.request(url, "text", {
      method: "POST",
      data: JSON.stringify(body),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    return parseJsonBody<T>(url, res.data as string);
  }

  async getBuffer(url: string): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await this.request(url, "arraybuffer");
    return {
      buffer: Buffer.from(res.data as ArrayBuffer),
      contentType: String(res.headers["content-type"] || ""),
    };
  }

  /**
   * Verify whether the current cookie authenticates a real user. The site now
   * has two halves with separate sessions:
   *  - classic pages (/market/view.html, classic tender cards, documentation)
   *    accept the old session cookie and render GlobalJsConfig.user_id. Any
   *    view.html page works, even a 404 one, and it is not captcha-protected
   *    (unlike the home page and most other sections);
   *  - the new app (market search API, market-next cards) logs in through its
   *    own OpenID "silent-auth" flow; /api/v1/config reports user.id = 0 for guests.
   */
  async checkAuth(): Promise<{ authenticated: boolean; userId: string | null; searchAuthenticated: boolean }> {
    const html = await this.getText(`${config.baseUrl}/market/view.html?id=1`, { allowStatus: [404] });
    const m = html.match(/"user_id"\s*:\s*(\d+|null|"\d+")/);
    const userId = m && m[1] !== "null" && m[1] !== "0" ? m[1]!.replace(/"/g, "") : null;
    const cfg = await this.getJson<{ user?: { id?: number } }>(`${config.baseUrl}/api/v1/config/?fields=user`);
    return { authenticated: Boolean(userId), userId, searchAuthenticated: Number(cfg.user?.id) > 0 };
  }

  private async request(
    url: string,
    responseType: "text" | "arraybuffer",
    opts: { method?: "GET" | "POST"; data?: string; headers?: Record<string, string>; allowStatus?: number[] } = {},
  ): Promise<AxiosResponse> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      await this.throttle();
      try {
        const cookie = this.cookieHeader();
        const res = await this.client.request({
          url,
          method: opts.method ?? "GET",
          data: opts.data,
          responseType,
          // Keep the raw body: JSON is parsed by the caller so that a non-JSON
          // answer (captcha/error page) can be reported instead of silently ignored.
          transformResponse: (d) => d,
          headers: { ...opts.headers, ...(cookie ? { Cookie: cookie } : {}) },
        });
        this.mergeSetCookie(res.headers["set-cookie"] as string[] | undefined);
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (res.status >= 400 && !opts.allowStatus?.includes(res.status)) {
          logger.warn(`${opts.method ?? "GET"} ${url} -> HTTP ${res.status}`);
        }
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

function parseJsonBody<T>(url: string, body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    const head = String(body ?? "").replace(/\s+/g, " ").slice(0, 120);
    throw new Error(`Ожидался JSON от ${url}, получено: ${head}`);
  }
}

export const fetcher = new Fetcher();
