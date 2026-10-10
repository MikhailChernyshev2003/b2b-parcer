import { upsertListItem } from "../db/db.js";
import { logger } from "../logger.js";
import type { SearchQuery, TenderListItem } from "../types.js";
import { buildSearchUrl, directionsOf } from "./searchParams.js";
import { assertSearchResponse, parseSearchResponse } from "./listParser.js";
import { fetcher } from "../http/fetcher.js";

export interface ScrapeSummary {
  queries: number;
  fetched: number;
  inserted: number;
  updated: number;
  uniqueIds: number;
  /** Session mode reported by the site ("guest" = cookie missing or not accepted). */
  mode: string | null;
}

export interface SearchPage {
  items: TenderListItem[];
  mode: string;
  pageCount: number;
  /** Total hits in the requested tab, as reported by the site. */
  total: number | null;
}

/** Run a single search API request. */
export async function scrapeOnce(query: SearchQuery, direction: "buy" | "sell", page = 1): Promise<SearchPage> {
  const status = query.status ?? "actual";
  const url = buildSearchUrl(query, direction, page);
  logger.info(`Fetch list: ${url}`);
  const data = await fetcher.getJson(url);
  assertSearchResponse(data);
  const items = parseSearchResponse(data, status);
  const total = data.tabs?.find((t) => t.type === status)?.count ?? null;
  logger.info(`  parsed ${items.length} rows (найдено на сайте: ${total ?? "?"}, режим: ${data.mode})`);
  if (!items.length && total) {
    logger.warn(`  сайт сообщает о ${total} результатах, но список пуст — проверьте парсер`);
  }
  return { items, mode: data.mode, pageCount: data.page_count || 1, total };
}

/**
 * Scrape a set of queries and persist results.
 *
 * Pagination: the site reports `mode: "guest"` when the cookie is missing or
 * rejected and then always returns the first 20 matches, so paging is attempted
 * only for a recognised session, up to maxPages / page_count.
 */
export async function scrapeQueries(
  queries: SearchQuery[],
  opts: { maxPages?: number } = {},
): Promise<ScrapeSummary> {
  const maxPages = Math.max(1, opts.maxPages ?? 5);
  const summary: ScrapeSummary = {
    queries: queries.length,
    fetched: 0,
    inserted: 0,
    updated: 0,
    uniqueIds: 0,
    mode: null,
  };
  const seen = new Set<string>();

  for (const query of queries) {
    for (const direction of directionsOf(query)) {
      for (let page = 1; page <= maxPages; page++) {
        const res = await scrapeOnce(query, direction, page);
        summary.mode = res.mode;
        for (const item of res.items) {
          summary.fetched++;
          seen.add(item.id);
          const r = upsertListItem(item);
          if (r === "inserted") summary.inserted++;
          else summary.updated++;
        }
        if (res.mode === "guest" || page >= res.pageCount || !res.items.length) break;
      }
    }
  }

  summary.uniqueIds = seen.size;
  if (summary.mode === "guest") {
    logger.info("Гостевой режим: по каждому запросу доступны только первые 20 результатов.");
  }
  if (queries.length && summary.fetched === 0) {
    logger.warn(
      `Сбор не вернул ни одной записи по ${queries.length} запросам. Если на сайте тендеры есть — вероятно, изменился API B2B-Center.`,
    );
  }
  return summary;
}

export interface FeedOptions {
  status?: SearchQuery["status"];
  trade?: SearchQuery["trade"];
  /** Hard cap on pages per direction (the site has ~320 pages of actual buy trades). */
  maxPages?: number;
  /** Stop after this many consecutive pages without new tenders (caught up). */
  stopAfterKnownPages?: number;
}

/**
 * Walk the whole market newest-first, without keywords, until we reach tenders
 * that are already in the DB. Needs an authenticated search session: for a
 * guest the site returns only the first 20 rows, which is reported in `mode`
 * so the caller can fall back to keyword queries.
 */
export async function scrapeFeed(opts: FeedOptions = {}): Promise<ScrapeSummary> {
  const query: SearchQuery = { status: opts.status ?? "actual", trade: opts.trade ?? "buy" };
  const maxPages = Math.max(1, opts.maxPages ?? 400);
  const stopAfter = Math.max(1, opts.stopAfterKnownPages ?? 2);
  const summary: ScrapeSummary = { queries: 1, fetched: 0, inserted: 0, updated: 0, uniqueIds: 0, mode: null };
  const seen = new Set<string>();

  for (const direction of directionsOf(query)) {
    let knownPages = 0;
    for (let page = 1; page <= maxPages; page++) {
      const res = await scrapeOnce(query, direction, page);
      summary.mode = res.mode;
      let inserted = 0;
      for (const item of res.items) {
        summary.fetched++;
        seen.add(item.id);
        if (upsertListItem(item) === "inserted") inserted++;
        else summary.updated++;
      }
      summary.inserted += inserted;
      if (res.mode === "guest" || page >= res.pageCount || !res.items.length) break;
      knownPages = inserted ? 0 : knownPages + 1;
      if (knownPages >= stopAfter) {
        logger.info(`  лента: ${stopAfter} стр. подряд без новых тендеров — догнали`);
        break;
      }
    }
  }

  summary.uniqueIds = seen.size;
  if (summary.mode === "guest") logger.warn("Лента недоступна гостю: сайт отдал только первые 20 записей.");
  return summary;
}

/**
 * Expand one query over a date range into per-day queries.
 * Date filters are honoured by the site only for an authenticated session.
 * Dates are dd.mm.yyyy. Returns queries with dateFrom == dateTo for each day.
 */
export function sliceByDay(query: SearchQuery, fromDmy: string, toDmy: string): SearchQuery[] {
  const from = parseDmy(fromDmy);
  const to = parseDmy(toDmy);
  if (!from || !to || from > to) return [{ ...query, dateFrom: fromDmy, dateTo: toDmy }];
  const out: SearchQuery[] = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const dmy = toDmy_(d);
    out.push({ ...query, dateFrom: dmy, dateTo: dmy });
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
