import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const FILES_DIR = path.join(DATA_DIR, "files");
export const DB_PATH = process.env.B2B_DB_PATH || path.join(DATA_DIR, "tenders.sqlite");

export const config = {
  baseUrl: process.env.B2B_BASE_URL || "https://www.b2b-center.ru",
  marketPath: "/market/",
  userAgent:
    process.env.B2B_USER_AGENT ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  /** Optional Cookie header value for an authenticated session (enables deep pagination). */
  authCookie: process.env.B2B_AUTH_COOKIE || "",
  /** Politeness delay between HTTP requests, ms. */
  requestDelayMs: Number(process.env.B2B_REQUEST_DELAY_MS || 1500),
  requestTimeoutMs: Number(process.env.B2B_REQUEST_TIMEOUT_MS || 40000),
  maxRetries: Number(process.env.B2B_MAX_RETRIES || 3),
  /**
   * OpenID client of b2b-center's own web app. The new app (search API,
   * market-next cards) accepts only a Bearer token; we obtain it the same way
   * the site does in the browser — a silent login with the user's session cookie.
   */
  oidcClientId: process.env.B2B_OIDC_CLIENT_ID || "5d438a01-eda7-4a88-9a68-a21f3ce3d4b0",
  /** Max parallel HTTP requests (kept low to stay polite / avoid throttling). */
  concurrency: Number(process.env.B2B_CONCURRENCY || 1),
} as const;

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, FILES_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
