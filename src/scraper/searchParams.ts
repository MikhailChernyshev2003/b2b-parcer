import { config } from "../config.js";
import type { SearchQuery } from "../types.js";

/** JSON endpoint behind the market search page (/app/next/market-search/). */
export const SEARCH_API_PATH = "/site/api/v1/market-search/";

/** The site never returns more than this per page. */
export const SEARCH_PAGE_SIZE = 20;

/**
 * Build an absolute market search API URL for one trade direction.
 *
 * NOTE on guests: b2b-center answers with `mode: "guest"` and then honours only
 * `query` and `tab` — page, sort, dates and price are ignored and the first 20
 * matches are returned. Breadth for guests therefore comes from many narrow
 * keyword queries; an authenticated cookie unlocks paging and filters.
 */
export function buildSearchUrl(query: SearchQuery, direction: "buy" | "sell", page = 1): string {
  const p = new URLSearchParams();
  p.set("query", query.keyword ?? "");
  p.set("company_type", "2");
  p.set("mod_derivatives", "false");
  p.set("mod_phrase", "false");
  p.set("page", String(page));
  p.set("page_size", String(SEARCH_PAGE_SIZE));
  p.set("sort", "date_desc");
  p.set("macro_trade_type", direction);
  p.set("tab", query.status ?? "actual");
  p.set("is_seo", "0");

  if (query.dateFrom) p.set("date_start_dmy", query.dateFrom);
  if (query.dateTo) p.set("date_end_dmy", query.dateTo);
  if (query.organizerId) p.set("firm_id", query.organizerId);
  if (query.priceFrom != null) p.set("price_start", String(query.priceFrom));
  if (query.priceTo != null) p.set("price_end", String(query.priceTo));

  return `${config.baseUrl}${SEARCH_API_PATH}?${p.toString()}`;
}

/** Trade directions to request for a query ("all" = both). */
export function directionsOf(query: SearchQuery): ("buy" | "sell")[] {
  if (query.trade === "sell") return ["sell"];
  if (query.trade === "all") return ["buy", "sell"];
  return ["buy"];
}
