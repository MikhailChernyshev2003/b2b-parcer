import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDirs } from "./config.js";

const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

export interface Settings {
  /** Cookie header value for an authenticated b2b-center session. */
  authCookie: string;
  /** Scheduler interval in minutes. */
  pollIntervalMinutes: number;
  /** During a scheduler cycle, fetch detail cards for new tenders. */
  autoEnrich: boolean;
  /** During enrichment, download + extract documentation (requires auth). */
  autoDownloadDocs: boolean;
  /** Max cards to enrich per cycle (politeness cap). */
  enrichPerCycle: number;
}

const DEFAULTS: Settings = {
  authCookie: process.env.B2B_AUTH_COOKIE || "",
  pollIntervalMinutes: 30,
  autoEnrich: true,
  autoDownloadDocs: true,
  enrichPerCycle: 50,
};

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  ensureDirs();
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      cache = { ...DEFAULTS, ...raw };
      return cache!;
    } catch {
      /* fall through to defaults */
    }
  }
  cache = { ...DEFAULTS };
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch };
  // Basic sanitation.
  next.pollIntervalMinutes = Math.min(Math.max(Math.round(next.pollIntervalMinutes) || 30, 1), 1440);
  next.enrichPerCycle = Math.min(Math.max(Math.round(next.enrichPerCycle) || 50, 1), 1000);
  ensureDirs();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf-8");
  cache = next;
  return next;
}

/** True if an auth cookie is configured. */
export function hasAuth(): boolean {
  return Boolean(getSettings().authCookie.trim());
}

export interface CookiePair {
  name: string;
  value: string;
}

/** Remove surrounding quotes / whitespace that users often paste by accident. */
function sanitizeValue(v: string): string {
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s.replace(/;+$/, "").trim();
}

/** Parse a raw "a=1; b=2" cookie header into name/value pairs. */
export function parseCookiePairs(raw: string): CookiePair[] {
  const out: CookiePair[] = [];
  for (const part of String(raw).split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = sanitizeValue(part.slice(eq + 1));
    if (name) out.push({ name, value });
  }
  return out;
}

/**
 * Parse cookies from various pasted formats and keep only the ones for a domain:
 *  - DevTools "Application → Cookies" table (tab-separated: name, value, domain, …);
 *  - a raw Cookie header ("a=1; b=2");
 *  - "name<TAB>value" lines.
 * Cookies whose domain does not contain `domainFilter` are dropped (e.g. yandex,
 * analytics), so a full browser cookie dump can be pasted as-is.
 */
export function parseCookieDump(raw: string, domainFilter = "b2b-center.ru"): CookiePair[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const byName = new Map<string, string>();

  // A Cookie header never contains tabs, so any tab means the DevTools table format.
  const hasTabularRows = /\t/.test(text);
  if (hasTabularRows) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cols = line.split("\t");
      if (cols.length < 2) continue;
      const name = (cols[0] ?? "").trim();
      const value = sanitizeValue(cols[1] ?? "");
      const domain = (cols[2] ?? "").trim().replace(/^\./, "").toLowerCase();
      if (!name || !value) continue;
      // If a domain column exists, filter by it; otherwise accept the pair.
      if (cols.length >= 3 && domain && !domain.includes(domainFilter)) continue;
      byName.set(name, value);
    }
  } else if (text.includes(";") || /^[^=\s]+=/.test(text)) {
    for (const p of parseCookiePairs(text)) byName.set(p.name, p.value);
  }

  return [...byName.entries()].map(([name, value]) => ({ name, value }));
}

/** Build a Cookie header string from name/value pairs (sanitized). */
export function assembleCookie(pairs: CookiePair[]): string {
  return pairs
    .map((p) => ({ name: String(p.name ?? "").trim(), value: sanitizeValue(String(p.value ?? "")) }))
    .filter((p) => p.name && p.value)
    .map((p) => `${p.name}=${p.value}`)
    .join("; ");
}

/** Safe view for the API. Returns parsed pairs so the editor can repopulate. */
export function settingsView() {
  const s = getSettings();
  const cookie = s.authCookie.trim();
  return {
    pollIntervalMinutes: s.pollIntervalMinutes,
    autoEnrich: s.autoEnrich,
    autoDownloadDocs: s.autoDownloadDocs,
    enrichPerCycle: s.enrichPerCycle,
    authCookieSet: Boolean(cookie),
    authCookiePairs: parseCookiePairs(cookie),
  };
}
