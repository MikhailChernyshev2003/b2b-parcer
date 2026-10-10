import * as cheerio from "cheerio";
import { config } from "../config.js";
import type { MarketStatus, TenderListItem } from "../types.js";
import { clean, extractTenderId, parseRuDate } from "../util.js";

/** One trade in the market search API response (fields we use). */
export interface SearchApiTrade {
  trade_id: number;
  sphinx_id?: number;
  description?: string;
  url: string;
  date_actual?: string;
  date_published?: string;
  org_name_short?: string;
  org_name_url?: string;
  price?: string;
  region?: string;
  tags?: string;
}

/** Market search API response (/site/api/v1/market-search/). */
export interface SearchApiResponse {
  /** "guest" for anonymous sessions; anything else means the cookie is accepted. */
  mode: string;
  trades: SearchApiTrade[];
  page_count: number;
  tabs?: { type: string; name: string; count: number }[];
}

/** Throw if the payload is not a market search response (site changed again?). */
export function assertSearchResponse(data: unknown): asserts data is SearchApiResponse {
  const r = data as Partial<SearchApiResponse> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.trades) || typeof r.mode !== "string") {
    const keys = r && typeof r === "object" ? Object.keys(r).join(", ") : typeof r;
    throw new Error(
      `Ответ поиска B2B-Center не распознан (ключи: ${keys}). Вероятно, сайт изменил API — нужна правка парсера.`,
    );
  }
}

/** Map API trades to list items. HTML entities and <mark> highlights are stripped. */
export function parseSearchResponse(res: SearchApiResponse, status: MarketStatus): TenderListItem[] {
  const scrapedAt = new Date().toISOString();
  const items: TenderListItem[] = [];

  for (const t of res.trades) {
    const url = absUrl(t.url.split("#")[0]!);
    const id = String(t.trade_id ?? extractTenderId(url) ?? "");
    if (!id) continue;

    const description = text(t.description);
    items.push({
      id,
      tsid: t.sphinx_id != null ? String(t.sphinx_id) : null,
      // Not present in search results; filled in from the card.
      procedureType: null,
      category: text(t.tags),
      title: description || `Процедура № ${id}`,
      description,
      url,
      organizerName: text(t.org_name_short),
      organizerUrl: t.org_name_url ? absUrl(t.org_name_url) : null,
      region: text(t.region),
      price: text(t.price),
      publishedAt: parseRuDate(t.date_published),
      actualUntil: parseRuDate(t.date_actual),
      status,
      scrapedAt,
    });
  }

  return items;
}

/** Decode entities / drop tags from an API string field. */
function text(s: string | undefined | null): string | null {
  if (!s) return null;
  return clean(cheerio.load(s, null, false).text());
}

function absUrl(href: string): string {
  if (href.startsWith("http")) return href;
  return `${config.baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;
}
