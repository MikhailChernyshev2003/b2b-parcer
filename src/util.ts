/** Collapse whitespace and trim. Returns null for empty. */
export function clean(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  return t.length ? t : null;
}

/**
 * Parse a b2b date like "17.06.2026 20:19" or "24.06.2026" into ISO 8601.
 * Returns the original string if it cannot be parsed.
 */
export function parseRuDate(raw: string | null | undefined): string | null {
  const s = clean(raw);
  if (!s) return null;
  const m = s.match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return s;
  const [, dd, mm, yyyy, hh = "00", mi = "00", ss = "00"] = m;
  // Treat as Moscow time (UTC+3); store with explicit offset.
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+03:00`;
}

/** Extract a label/value pair from "Label: value" text. */
export function splitLabelValue(text: string | null): { label: string | null; value: string | null } {
  const t = clean(text);
  if (!t) return { label: null, value: null };
  const idx = t.indexOf(":");
  if (idx < 0) return { label: null, value: t };
  return { label: clean(t.slice(0, idx)), value: clean(t.slice(idx + 1)) };
}

/** Extract the numeric procedure id from a card URL (".../tender-4492697/"). */
export function extractTenderId(url: string): string | null {
  const m = url.match(/tender-(\d+)/);
  return m ? m[1]! : null;
}

/** Sleep helper. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
