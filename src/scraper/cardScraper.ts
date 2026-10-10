import fs from "node:fs";
import path from "node:path";
import { FILES_DIR } from "../config.js";
import { getTendersWithoutCard, saveCard, saveDocText, saveFile, saveFileText, type TenderRow } from "../db/db.js";
import { fetcher } from "../http/fetcher.js";
import { logger } from "../logger.js";
import type { TenderCard } from "../types.js";
import { parseCard } from "./cardParser.js";
import { fetchTradeCard, isMarketNextUrl } from "./tradeApi.js";
import { extractTenderId } from "../util.js";
import { extractText } from "./docs.js";

/** Fetch and parse a single tender card, persisting the result. */
export async function fetchCard(url: string, opts: { downloadFiles?: boolean } = {}): Promise<TenderCard> {
  const cleanUrl = url.split("#")[0]!;
  logger.info(`Fetch card: ${cleanUrl}`);
  let card: TenderCard;
  if (isMarketNextUrl(cleanUrl)) {
    card = await fetchTradeCard(extractTenderId(cleanUrl) ?? "", cleanUrl);
  } else {
    card = parseCard(await fetcher.getText(cleanUrl), cleanUrl);
  }
  if (!card.id || (!card.procedureType && !card.organizerName && !card.endAt)) {
    // Nothing recognised: saving it would mark the tender as "card loaded" with empty data.
    throw new Error(`карточка не распознана (${cleanUrl}) — вероятно, изменилась вёрстка или API B2B-Center`);
  }
  logger.info(
    `  ${card.procedureType ?? "?"} | "${(card.title ?? "").slice(0, 60)}" | files=${card.files.length}${
      card.requiresAuth ? " | requiresAuth" : ""
    }`,
  );
  if (opts.downloadFiles && card.files.length) await downloadCardFiles(card);
  saveCard(card);
  return card;
}

/** Enrich tenders that don't yet have card details. */
export async function enrichCards(limit: number, opts: { downloadFiles?: boolean } = {}): Promise<number> {
  const rows: TenderRow[] = getTendersWithoutCard(limit);
  logger.info(`Enriching ${rows.length} tenders without card data`);
  let ok = 0;
  for (const row of rows) {
    try {
      await fetchCard(row.url, opts);
      ok++;
    } catch (err) {
      logger.error(`Card failed for ${row.id}: ${(err as Error).message}`);
    }
  }
  return ok;
}

/**
 * Download accessible files for a card into data/files/<tenderId>/, extract their
 * text, and store the aggregated documentation text for criteria matching.
 */
export async function downloadCardFiles(card: TenderCard): Promise<void> {
  const dir = path.join(FILES_DIR, card.id);
  fs.mkdirSync(dir, { recursive: true });
  const parts: string[] = [];
  for (const file of card.files) {
    try {
      const { buffer, contentType } = await fetcher.getBuffer(file.url);
      // Skip auth-wall HTML returned in place of a binary document.
      if (/text\/html/i.test(contentType) && !/\.html?$/i.test(file.name)) {
        logger.warn(`    пропуск ${file.name}: получен HTML (нет доступа к файлу)`);
        continue;
      }
      const safeName = sanitizeFilename(file.name) || `file-${Date.now()}`;
      const dest = path.join(dir, safeName);
      fs.writeFileSync(dest, buffer);
      file.localPath = path.relative(FILES_DIR, dest);
      saveFile(card.id, file);
      logger.info(`    скачан ${file.localPath} (${buffer.length} байт)`);

      const text = await extractText(buffer, file.name, contentType);
      if (text) {
        saveFileText(card.id, file.url, text);
        parts.push(`# ${file.name}\n${text}`);
        logger.info(`      извлечено ${text.length} символов текста`);
      }
    } catch (err) {
      logger.warn(`    скачивание не удалось (${file.url}): ${(err as Error).message}`);
    }
  }
  if (parts.length) saveDocText(card.id, parts.join("\n\n").slice(0, 200_000));
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
