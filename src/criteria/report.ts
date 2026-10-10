import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDirs } from "../config.js";
import type { MatchResult } from "./matcher.js";

export interface ReportPaths {
  json: string;
  csv: string;
}

/** Write matches to data/report.json and data/report.csv, return their paths. */
export function writeReport(matches: MatchResult[]): ReportPaths {
  ensureDirs();
  const json = path.join(DATA_DIR, "report.json");
  const csv = path.join(DATA_DIR, "report.csv");

  const rows = matches.map((m) => ({
    id: m.tender.id,
    score: m.score,
    procedureType: m.tender.procedure_type,
    title: m.tender.title,
    category: m.tender.category,
    region: m.tender.region,
    organizer: m.tender.organizer_name,
    price: m.tender.price,
    publishedAt: m.tender.published_at,
    endAt: m.tender.end_at ?? m.tender.actual_until,
    url: m.tender.url,
    reasons: m.reasons,
  }));

  fs.writeFileSync(json, JSON.stringify(rows, null, 2), "utf-8");

  const headers = ["id", "score", "procedureType", "title", "category", "region", "organizer", "price", "publishedAt", "endAt", "url", "reasons"];
  const csvLines = [headers.join(";")];
  for (const r of rows) {
    csvLines.push(
      headers
        .map((h) => {
          const v = (r as Record<string, unknown>)[h];
          const s = Array.isArray(v) ? v.join(" | ") : v == null ? "" : String(v);
          return `"${s.replace(/"/g, '""')}"`;
        })
        .join(";"),
    );
  }
  fs.writeFileSync(csv, "\uFEFF" + csvLines.join("\n"), "utf-8");

  return { json, csv };
}

/** Pretty console summary of the top matches. */
export function printReport(matches: MatchResult[], top = 20): void {
  if (!matches.length) {
    console.log("\nПодходящих тендеров не найдено.\n");
    return;
  }
  console.log(`\nНайдено подходящих тендеров: ${matches.length}. Топ ${Math.min(top, matches.length)}:\n`);
  for (const m of matches.slice(0, top)) {
    const t = m.tender;
    console.log(`[${m.score}] ${t.procedure_type ?? ""} № ${t.id} — ${t.title ?? ""}`.trim());
    if (t.organizer_name) console.log(`     Организатор: ${t.organizer_name}`);
    if (t.region || t.price) console.log(`     ${[t.region, t.price].filter(Boolean).join(" | ")}`);
    console.log(`     Окончание: ${t.end_at ?? t.actual_until ?? "—"}`);
    console.log(`     Причины: ${m.reasons.join("; ")}`);
    console.log(`     ${t.url}`);
    console.log("");
  }
}
