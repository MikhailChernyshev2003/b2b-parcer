import fs from "node:fs";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { FILES_DIR } from "../config.js";
import { getTenderFiles, getTendersNeedingDocIndex, saveDocText, saveFileText } from "../db/db.js";
import { logger } from "../logger.js";

const MAX_DOC_CHARS = 200_000; // cap aggregated text per tender

/** Extract plain text from a document buffer based on extension / content-type. */
export async function extractText(
  buffer: Buffer,
  filename: string,
  contentType = "",
): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  // An auth wall / error page returns HTML instead of the real file.
  if (/text\/html/i.test(contentType) && ![".html", ".htm", ".txt"].includes(ext)) return "";

  try {
    if (ext === ".pdf" || /application\/pdf/i.test(contentType)) {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const res = await parser.getText();
        return normalize(res.text);
      } finally {
        await parser.destroy();
      }
    }
    if (ext === ".docx") {
      const mammoth: any = await import("mammoth");
      const res = await (mammoth.default ?? mammoth).extractRawText({ buffer });
      return normalize(res.value);
    }
    if ([".txt", ".csv", ".rtf"].includes(ext)) {
      return normalize(buffer.toString("utf-8"));
    }
  } catch (err) {
    logger.warn(`Извлечение текста не удалось (${filename}): ${(err as Error).message}`);
  }
  return ""; // unsupported (doc, xls, zip, images) — skipped for now
}

function normalize(s: string): string {
  return s.replace(/\u0000/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Re-extract text from already-downloaded files of a tender and aggregate. */
export async function indexTenderDocs(tenderId: string): Promise<number> {
  const files = getTenderFiles(tenderId).filter((f) => f.local_path);
  const parts: string[] = [];
  for (const f of files) {
    const abs = path.join(FILES_DIR, f.local_path!);
    if (!fs.existsSync(abs)) continue;
    const text = await extractText(fs.readFileSync(abs), f.name || f.local_path!);
    if (text) {
      saveFileText(tenderId, f.url, text);
      parts.push(`# ${f.name ?? ""}\n${text}`);
    }
  }
  const aggregated = parts.join("\n\n").slice(0, MAX_DOC_CHARS);
  saveDocText(tenderId, aggregated);
  return aggregated.length;
}

/** Index documentation for all tenders that have files but no aggregated text. */
export async function indexPendingDocs(limit = 100): Promise<number> {
  const rows = getTendersNeedingDocIndex(limit);
  logger.info(`Индексация документации: ${rows.length} тендеров`);
  let done = 0;
  for (const r of rows) {
    const chars = await indexTenderDocs(r.id);
    logger.info(`  ${r.id}: ${chars} символов текста`);
    done++;
  }
  return done;
}
