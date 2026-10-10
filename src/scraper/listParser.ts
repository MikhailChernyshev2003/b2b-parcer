import * as cheerio from "cheerio";
import { config } from "../config.js";
import type { MarketStatus, TenderListItem } from "../types.js";
import { clean, extractTenderId, parseRuDate } from "../util.js";

/**
 * Parse the /market/ search results table into structured rows.
 *
 * Table markup (server-rendered):
 *   table.search-results > tbody > tr
 *     td[0]: <small>category</small><a class="search-results-title" href="...tender-N/">Тип № N</a>
 *            <div class="search-results-title-desc">description</div>
 *     td[1]: <a href="/firms/...">organizer</a>
 *     td[2]: published date "dd.mm.yyyy hh:mm"
 *     td[3]: actual-until date
 *     td[4]: span.favorite-container[data-id=tsid]
 */
export function parseSearchList(html: string, status: MarketStatus): TenderListItem[] {
  const $ = cheerio.load(html);
  const scrapedAt = new Date().toISOString();
  const items: TenderListItem[] = [];

  $("table.search-results tbody tr").each((_, tr) => {
    const $tr = $(tr);
    const $cells = $tr.children("td");
    if ($cells.length < 3) return;

    const $titleCell = $cells.eq(0);
    const $link = $titleCell.find("a.search-results-title").first();
    const href = $link.attr("href") || "";
    if (!href.includes("tender-")) return;

    const url = absUrl(href);
    const id = extractTenderId(url);
    if (!id) return;

    const category = clean($titleCell.find("small").first().text());
    const description = clean($titleCell.find(".search-results-title-desc").first().text());

    // Link text is "Тип процедуры № 12345" possibly followed by the desc div text.
    const linkText = clean($link.clone().children("div").remove().end().text()) || "";
    const { procedureType } = parseTitleLine(linkText);

    const $org = $cells.eq(1).find("a").first();
    const organizerName = clean($org.text());
    const organizerUrl = $org.attr("href") ? absUrl($org.attr("href")!) : null;

    const publishedAt = parseRuDate($cells.eq(2).text());
    const actualUntil = parseRuDate($cells.eq(3).text());

    const tsid =
      $cells.eq(4).find("[data-id]").attr("data-id") ||
      new URL(url).searchParams.get("tsid") ||
      tsidFromHash(href);

    const title = description || linkText || `Процедура № ${id}`;

    items.push({
      id,
      tsid: tsid || null,
      procedureType,
      category,
      title,
      description,
      url,
      organizerName,
      organizerUrl,
      publishedAt,
      actualUntil,
      status,
      scrapedAt,
    });
  });

  return items;
}

function parseTitleLine(text: string): { procedureType: string | null; number: string | null } {
  // e.g. "Запрос предложений № 4492697" / "Объявление о продаже № 4492688"
  const m = text.match(/^(.*?)\s*№\s*(\d+)/);
  if (m) return { procedureType: clean(m[1]), number: m[2]! };
  return { procedureType: clean(text) || null, number: null };
}

function tsidFromHash(href: string): string | null {
  const m = href.match(/tsid=(\d+)/);
  return m ? m[1]! : null;
}

function absUrl(href: string): string {
  if (href.startsWith("http")) return href;
  return `${config.baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;
}
