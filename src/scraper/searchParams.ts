import { config } from "../config.js";
import { hasAuth } from "../settings.js";
import type { DateMode, MarketStatus, SearchQuery, TradeType } from "../types.js";

const DATE_MODE_CODE: Record<DateMode, string> = {
  published: "1",
  actual: "2",
  changed: "3",
};

const TRADE_CODE: Record<TradeType, string> = {
  all: "all",
  buy: "buy",
  sell: "sell",
};

const STATUS_PARAM: Record<MarketStatus, string | null> = {
  actual: null, // default view
  archive: "archive",
  all: "all",
};

/**
 * Build an absolute /market/ search URL from a SearchQuery.
 *
 * NOTE on pagination: for unauthenticated (guest) sessions b2b-center ignores
 * the page parameter and only returns the first ~20 newest matches. To go
 * "deeper" without auth we slice the search space by keyword + date window
 * (see marketScraper). When an authenticated cookie is configured, the `page`
 * argument is appended so a real session can paginate.
 */
export function buildSearchUrl(query: SearchQuery, page?: number): string {
  const p = new URLSearchParams();
  p.set("searching", "1");

  if (query.keyword) p.set("f_keyword", query.keyword);

  const status = query.status ?? "actual";
  const showVal = STATUS_PARAM[status];
  if (showVal) p.set("show", showVal);

  if (query.trade && query.trade !== "all") p.set("trade", TRADE_CODE[query.trade]);

  if (query.dateMode) p.set("date", DATE_MODE_CODE[query.dateMode]);
  if (query.dateFrom) p.set("date_start_dmy", query.dateFrom);
  if (query.dateTo) p.set("date_end_dmy", query.dateTo);

  if (query.region) p.set("region", query.region);
  if (query.customerId) p.set("customer_id", query.customerId);
  if (query.organizerId) p.set("firm_id", query.organizerId);
  if (query.priceFrom != null) p.set("price_start", String(query.priceFrom));
  if (query.priceTo != null) p.set("price_end", String(query.priceTo));
  if (query.onlySmp) p.set("show_trades_for_smp", "1");
  if (query.only223fz) p.set("fz", "223");

  if (page && page > 1 && hasAuth()) p.set("page", String(page));

  return `${config.baseUrl}${config.marketPath}?${p.toString()}`;
}
