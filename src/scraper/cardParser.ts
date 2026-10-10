import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { config } from "../config.js";
import type { TenderCard, TenderFile } from "../types.js";
import { clean, extractTenderId, parseRuDate, splitLabelValue } from "../util.js";

const FILE_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|jpe?g|png|tiff?|csv|txt|rtf)(\?|$)/i;

/**
 * Parse a tender card page (classic /market/<slug>/tender-N/ layout).
 *
 * Stable hooks observed:
 *   h1                              -> "Тип № N <title text>"
 *   #trade-info-organizer-name      -> "Организатор: ..."
 *   #trade_info_date_begin          -> "Дата публикации: ..."
 *   #trade_info_date_end            -> "Дата окончания подачи заявок: ..."
 *   #trade-info-lot-price           -> "Общая стоимость закупки: ..."
 *   #trade-info-lot-price-currency  -> "Вид валюты: ..."
 * plus free-form rows ("Тег:", "Участники закупки:", "Условия оплаты:", ...).
 */
export function parseCard(html: string, pageUrl: string): TenderCard {
  const $ = cheerio.load(html);
  const id = extractTenderId(pageUrl) || "";

  const h1 = parseH1($);
  const titleMeta = parseTitleTag($);
  // The <title> marker for tenders is the generic word "Тендер"; the list page
  // already holds the specific type (e.g. "Запрос предложений"), so don't let the
  // generic label overwrite it (left null -> COALESCE keeps the better value).
  const titleType = /^Тендер/i.test(titleMeta.typeLabel ?? "") ? null : titleMeta.typeLabel;
  const procedureType = h1.procedureType || titleType;
  const title = titleMeta.title || h1.title;

  const organizerName = valueOf($, "#trade-info-organizer-name") || titleMeta.organizer;
  const publishedAt = parseRuDate(valueOf($, "#trade_info_date_begin"));
  const endAt = parseRuDate(valueOf($, "#trade_info_date_end"));
  const price = valueOf($, "#trade-info-lot-price");
  const currency = valueOf($, "#trade-info-lot-price-currency");
  const quantity = valueOf($, "#trade-info-lot-quantity");

  const infoRows = sweepInfoRows($);
  const region = titleMeta.region;
  const category = infoRows["Тег"] || infoRows["Категория справочника закупаемой продукции и услуг"] || null;
  const participants = infoRows["Участники закупки"] || null;
  const paymentTerms = infoRows["Условия оплаты"] || null;
  const deliveryTerms = infoRows["Условия поставки"] || null;
  const lastEditedAt = parseRuDate(infoRows["Дата последнего редактирования"] || null);
  const customerName = infoRows["Заказчик"] || null;
  if (quantity) infoRows["Количество"] = quantity;

  const files = extractFiles($);
  const requiresAuth = detectAuthWall($);

  return {
    id,
    url: pageUrl,
    procedureType,
    title: title || titleMeta.title,
    organizerName,
    customerName,
    region,
    category,
    publishedAt,
    endAt,
    lastEditedAt,
    price,
    currency,
    participants,
    paymentTerms,
    deliveryTerms,
    requiresAuth,
    files,
    infoRows,
    fetchedAt: new Date().toISOString(),
  };
}

/** Procedure type label (without "№ N") + leftover title text from the H1. */
function parseH1($: CheerioAPI): { procedureType: string | null; title: string | null } {
  const raw = clean($("h1").first().text());
  if (!raw) return { procedureType: null, title: null };
  // Strip the "Зарегистрируйтесь, чтобы..." call-to-action that sits inside h1.
  const cleaned = raw.replace(/Зарегистрируйтесь.*?Избранное/gi, " ").replace(/\s+/g, " ").trim();
  const m = cleaned.match(/^(.*?)№\s*\d+\s*(.*)$/);
  if (m) return { procedureType: clean(m[1]), title: clean(m[2]) };
  return { procedureType: null, title: cleaned };
}

/**
 * Parse the <title> tag. Two observed layouts:
 *   tender: "<title> — Тендер № N — <region> — <organizer> — B2B-Center"
 *   sale:   "Объявление о продаже № N — <title> — <organizer> — B2B-Center"
 * Strategy: locate the "<type> № N" marker segment, then split around it.
 */
function parseTitleTag($: CheerioAPI): {
  title: string | null;
  region: string | null;
  organizer: string | null;
  typeLabel: string | null;
} {
  const raw = clean($("title").first().text());
  if (!raw) return { title: null, region: null, organizer: null, typeLabel: null };

  const parts = (raw.split("—").map((s) => clean(s)).filter(Boolean) as string[]).filter(
    (p) => !/B2B-Center/i.test(p),
  );
  if (!parts.length) return { title: null, region: null, organizer: null, typeLabel: null };

  const markerIdx = parts.findIndex((p) => /№\s*\d+/.test(p));
  const lastIdx = parts.length - 1;
  const organizer = markerIdx === lastIdx ? null : (parts[lastIdx] ?? null);

  if (markerIdx < 0) {
    return { title: parts[0] ?? null, region: null, organizer, typeLabel: null };
  }

  const typeLabel = clean(parts[markerIdx]!.replace(/№\s*\d+.*$/, ""));

  if (markerIdx === 0) {
    // sale layout: marker first, then title, then organizer
    const titleParts = parts.slice(1, lastIdx > 0 ? lastIdx : undefined);
    return { title: clean(titleParts.join(" — ")), region: null, organizer, typeLabel };
  }

  // tender layout: title before marker, region between marker and organizer
  const title = clean(parts.slice(0, markerIdx).join(" — "));
  const mid = parts.slice(markerIdx + 1, lastIdx);
  const region = mid.length ? clean(mid.join(", ")) : null;
  return { title, region, organizer, typeLabel };
}

/** Read a "Label: value" element's value part by selector. */
function valueOf($: CheerioAPI, selector: string): string | null {
  const el = $(selector).first();
  if (!el.length) return null;
  return splitLabelValue(el.text()).value;
}

/** Collect all visible "Label: value" rows in the trade info area. */
function sweepInfoRows($: CheerioAPI): Record<string, string> {
  const rows: Record<string, string> = {};
  $("tr, li, div").each((_, el) => {
    const txt = clean($(el).text());
    if (!txt || txt.length > 400 || !txt.includes(":")) return;
    // Only single-line label/value (avoid grabbing whole containers).
    if ($(el).children().length > 4) return;
    const { label, value } = splitLabelValue(txt);
    if (label && value && label.length <= 80 && !(label in rows)) rows[label] = value;
  });
  return rows;
}

function extractFiles($: CheerioAPI): TenderFile[] {
  const files: TenderFile[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") || "";
    const isFile = FILE_EXT.test(href) || /\/(download|getfile|file)\b/i.test(href);
    if (!isFile) return;
    if (/logotype|logo|sprite|\/images\//i.test(href)) return;
    const url = href.startsWith("http") ? href : `${config.baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;
    if (seen.has(url)) return;
    seen.add(url);
    files.push({ name: clean($(a).text()) || href.split("/").pop() || "file", url, localPath: null });
  });
  return files;
}

function detectAuthWall($: CheerioAPI): boolean {
  const bodyText = $("body").text();
  return /Зарегистрируйтесь.{0,40}(скач|документац|заявк)|Войдите.{0,30}чтобы/i.test(bodyText);
}
