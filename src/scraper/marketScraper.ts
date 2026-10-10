import { hasAuth } from "../settings.js";
import { upsertListItem } from "../db/db.js";
import { logger } from "../logger.js";
import type { SearchQuery, TenderListItem } from "../types.js";
import { buildSearchUrl } from "./searchParams.js";
import { parseSearchList } from "./listParser.js";
import { fetcher } from "../http/fetcher.js";

export interface ScrapeSummary {
  queries: number;
  fetched: number;
  inserted: number;
  updated: number;
  uniqueIds: number;
}

/** Run a single search request and persist the parsed rows. */
export async function scrapeOnce(query: SearchQuery, page?: number): Promise<TenderListItem[]> {
  const url = buildSearchUrl(query, page);
  logger.info(`Fetch list: ${url}`);
  const html = await fetcher.getText(url);
  const items = parseSearchList(html, query.status ?? "actual");
  logger.info(`  parsed ${items.length} rows`);
  return items;
}

/**
 * Scrape a set of queries and persist results.
 *
 * Pagination strategy:
 *  - Authenticated session (B2B_AUTH_COOKIE set): walk pages 1..maxPages until a
 *    page returns no new ids.
 *  - Guest session: a single fetch returns the first ~20 newest matches (the site
 *    disables deep pagination for guests), so breadth must come from many narrow
 *    queries (different keywords / date windows) supplied by the caller.
 */
export async function scrapeQueries(
  queries: SearchQuery[],
  opts: { maxPages?: number } = {},
): Promise<ScrapeSummary> {
  const maxPages = hasAuth() ? Math.max(1, opts.maxPages ?? 5) : 1;
  const summary: ScrapeSummary = { queries: queries.length, fetched: 0, inserted: 0, updated: 0, uniqueIds: 0 };
  const seen = new Set<string>();

  for (const query of queries) {
    let prevPageIds = "";
    for (let page = 1; page <= maxPages; page++) {
      const items = await scrapeOnce(query, page);
      if (items.length === 0) break;
      const pageKey = items.map((i) => i.id).join(",");
      if (page > 1 && pageKey === prevPageIds) break; // page param had no effect -> stop
      prevPageIds = pageKey;

      for (const item of items) {
        summary.fetched++;
        seen.add(item.id);
        const res = upsertListItem(item);
        if (res === "inserted") summary.inserted++;
        else summary.updated++;
      }
    }
  }

  summary.uniqueIds = seen.size;
  return summary;
}

/**
 * Expand one query over a date range into per-day queries (guest-mode breadth).
 * Dates are dd.mm.yyyy. Returns queries with dateFrom == dateTo for each day.
 */
export function sliceByDay(query: SearchQuery, fromDmy: string, toDmy: string): SearchQuery[] {
  const from = parseDmy(fromDmy);
  const to = parseDmy(toDmy);
  if (!from || !to || from > to) return [{ ...query, dateFrom: fromDmy, dateTo: toDmy }];
  const out: SearchQuery[] = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const dmy = toDmy_(d);
    out.push({ ...query, dateMode: query.dateMode ?? "published", dateFrom: dmy, dateTo: dmy });
  }
  return out;
}

function parseDmy(s: string): Date | null {
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

function toDmy_(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}
