import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { FILES_DIR } from "../config.js";
import type { TenderRow } from "../db/db.js";
import type { AppField } from "./form.js";

/** Find a system TTF with Cyrillic support (macOS / Linux locations). */
function findFont(bold: boolean): string {
  const candidates = bold
    ? [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
      ]
    : [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
      ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      "Не найден TTF-шрифт с кириллицей. Установите DejaVu Sans или укажите путь в src/application/pdf.ts",
    );
  }
  return found;
}

/** Render the bid form into a PDF; returns the path relative to FILES_DIR. */
export async function renderApplicationPdf(tender: TenderRow, fields: AppField[]): Promise<string> {
  const dir = path.join(FILES_DIR, "applications");
  fs.mkdirSync(dir, { recursive: true });
  const relPath = path.join("applications", `zayavka-${tender.id}.pdf`);
  const absPath = path.join(FILES_DIR, relPath);

  const regular = findFont(false);
  const bold = findFont(true);

  const doc = new PDFDocument({ size: "A4", margins: { top: 56, bottom: 56, left: 56, right: 56 } });
  const stream = fs.createWriteStream(absPath);
  doc.pipe(stream);
  doc.registerFont("reg", regular);
  doc.registerFont("bold", bold);

  // Header
  doc.font("bold").fontSize(15).text("Заявка на участие / Коммерческое предложение", { align: "center" });
  doc.moveDown(0.6);
  doc.font("reg").fontSize(10).fillColor("#444");
  doc.text(`Процедура № ${tender.id}${tender.procedure_type ? ` — ${tender.procedure_type}` : ""}`, { align: "center" });
  doc.moveDown(0.2);
  doc.font("bold").fontSize(11).fillColor("#000").text(tender.title ?? "", { align: "center" });
  if (tender.organizer_name) {
    doc.moveDown(0.2);
    doc.font("reg").fontSize(10).fillColor("#444").text(`Организатор: ${tender.organizer_name}`, { align: "center" });
  }
  doc.moveDown(1);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor("#999").stroke();
  doc.moveDown(0.8);

  const writeField = (f: AppField) => {
    if (!f.value.trim()) return;
    doc.font("bold").fontSize(10.5).fillColor("#000").text(f.label);
    doc.moveDown(0.15);
    doc.font("reg").fontSize(10.5).fillColor("#111").text(f.value.trim(), { lineGap: 2 });
    doc.moveDown(0.6);
  };

  const std = fields.filter((f) => f.source === "standard" && f.id !== "cover");
  const docReqs = fields.filter((f) => f.source === "doc");
  const custom = fields.filter((f) => f.source === "custom");
  const cover = fields.find((f) => f.id === "cover");

  doc.font("bold").fontSize(12.5).text("1. Сведения об участнике и условия предложения");
  doc.moveDown(0.5);
  std.forEach(writeField);

  if (docReqs.some((f) => f.value.trim()) || custom.some((f) => f.value.trim())) {
    doc.moveDown(0.4);
    doc.font("bold").fontSize(12.5).text("2. Сведения по требованиям заказчика");
    doc.moveDown(0.5);
    docReqs.forEach(writeField);
    custom.forEach(writeField);
  }

  if (cover?.value.trim()) {
    doc.moveDown(0.4);
    doc.font("bold").fontSize(12.5).text("3. Сопроводительное письмо");
    doc.moveDown(0.5);
    doc.font("reg").fontSize(10.5).text(cover.value.trim(), { lineGap: 2 });
  }

  doc.moveDown(2);
  const today = new Date().toLocaleDateString("ru-RU");
  doc.font("reg").fontSize(10.5).text(`Дата: ${today}`);
  doc.moveDown(1.2);
  doc.text("Подпись: ____________________     М.П.");

  doc.end();
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
  return relPath;
}
