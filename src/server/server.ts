import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { FILES_DIR } from "../config.js";
import {
  countTenders,
  getTenderById,
  getTenderFiles,
  queryTenders,
  type TenderRow,
} from "../db/db.js";
import {
  criteriaFilePath,
  loadCriteriaSafe,
  saveCriteria,
} from "../criteria/criteria.js";
import { evaluate } from "../criteria/matcher.js";
import { logger } from "../logger.js";
import { fetcher } from "../http/fetcher.js";
import { enrichCards, fetchCard } from "../scraper/cardScraper.js";
import { indexPendingDocs } from "../scraper/docs.js";
import { scrapeQueries, sliceByDay } from "../scraper/marketScraper.js";
import { assembleCookie, getSettings, hasAuth, parseCookieDump, settingsView, updateSettings } from "../settings.js";
import { getSchedulerState, runCycle, startScheduler, stopScheduler } from "../scheduler.js";
import { getForm, saveForm, type AppField } from "../application/form.js";
import { renderApplicationPdf } from "../application/pdf.js";
import type { MarketStatus, SearchQuery, TradeType } from "../types.js";
import { getJob, isRunning, startJob } from "./jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "..", "public");

/** Attach criteria-based score/match info to a tender row for the UI. */
function withEvaluation(rows: TenderRow[]) {
  const criteria = loadCriteriaSafe();
  return rows.map((t) => {
    const e = evaluate(t, criteria);
    return { ...t, _score: e.score, _matched: e.matched, _reasons: e.reasons, _rejectedBy: e.rejectedBy };
  });
}

export function createServer(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Static UI + downloaded files.
  app.use(express.static(PUBLIC_DIR));
  app.use("/files", express.static(FILES_DIR));

  app.get("/api/stats", (_req, res) => {
    res.json({ ...countTenders(), authenticated: hasAuth() });
  });

  app.get("/api/tenders", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const sort = req.query.sort === "end" ? "end" : "published";
    const hasCard =
      req.query.hasCard === "true" ? true : req.query.hasCard === "false" ? false : undefined;
    const onlyMatched = req.query.matched === "true";

    let rows = withEvaluation(queryTenders({ q, status, sort, hasCard }));
    if (onlyMatched) rows = rows.filter((r) => r._matched);
    rows.sort((a, b) => b._score - a._score);
    res.json({ count: rows.length, tenders: rows });
  });

  app.get("/api/tenders/:id", (req, res) => {
    const row = getTenderById(req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });
    const criteria = loadCriteriaSafe();
    const e = evaluate(row, criteria);
    const files = getTenderFiles(req.params.id);
    let infoRows: Record<string, string> = {};
    try {
      infoRows = row.info_rows_json ? JSON.parse(row.info_rows_json) : {};
    } catch {
      /* ignore */
    }
    res.json({
      tender: row,
      infoRows,
      files,
      evaluation: { score: e.score, matched: e.matched, reasons: e.reasons, rejectedBy: e.rejectedBy },
    });
  });

  app.get("/api/criteria", (_req, res) => {
    res.json({ criteria: loadCriteriaSafe(), path: criteriaFilePath() });
  });

  app.put("/api/criteria", (req, res) => {
    try {
      const saved = saveCriteria(req.body);
      res.json({ criteria: saved, saved: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/job", (_req, res) => {
    res.json(getJob());
  });

  app.post("/api/scrape", (req, res) => {
    if (isRunning()) return res.status(409).json({ error: "Задача уже выполняется" });
    const body = req.body ?? {};
    const status: MarketStatus = (body.status as MarketStatus) || "actual";
    const trade: TradeType = (body.trade as TradeType) || "all";
    const keywords: string[] = Array.isArray(body.keywords)
      ? body.keywords.map(String).map((s: string) => s.trim()).filter(Boolean)
      : typeof body.keywords === "string"
        ? body.keywords.split(",").map((s: string) => s.trim()).filter(Boolean)
        : [];
    const dateFrom = typeof body.dateFrom === "string" ? body.dateFrom : undefined;
    const dateTo = typeof body.dateTo === "string" ? body.dateTo : undefined;

    const finalKeywords = keywords.length ? keywords : loadCriteriaSafe().keywordsAny;
    const base: SearchQuery = { status, trade };
    let queries: SearchQuery[] = finalKeywords.length
      ? finalKeywords.map((k) => ({ ...base, keyword: k }))
      : [base];
    if (dateFrom && dateTo) {
      queries = queries.flatMap((qq) => sliceByDay({ ...qq, dateMode: "published" }, dateFrom, dateTo));
    }

    const job = startJob("scrape", () => scrapeQueries(queries));
    res.json({ started: true, job });
  });

  app.post("/api/enrich", (req, res) => {
    if (isRunning()) return res.status(409).json({ error: "Задача уже выполняется" });
    const limit = Number(req.body?.limit) || 20;
    const downloadFiles = Boolean(req.body?.downloadFiles);
    const job = startJob("enrich", async () => ({ enriched: await enrichCards(limit, { downloadFiles }) }));
    res.json({ started: true, job });
  });

  app.post("/api/card", (req, res) => {
    if (isRunning()) return res.status(409).json({ error: "Задача уже выполняется" });
    const url = String(req.body?.url || "");
    if (!url) return res.status(400).json({ error: "url обязателен" });
    const downloadFiles = Boolean(req.body?.downloadFiles);
    const job = startJob("card", () => fetchCard(url, { downloadFiles }));
    res.json({ started: true, job });
  });

  // --- Заявка на участие ---
  app.get("/api/application/:id", (req, res) => {
    const tender = getTenderById(req.params.id);
    if (!tender) return res.status(404).json({ error: "тендер не найден" });
    res.json(getForm(tender));
  });

  app.put("/api/application/:id", (req, res) => {
    const tender = getTenderById(req.params.id);
    if (!tender) return res.status(404).json({ error: "тендер не найден" });
    const fields = req.body?.fields;
    if (!Array.isArray(fields)) return res.status(400).json({ error: "fields (массив) обязателен" });
    saveForm(tender.id, fields as AppField[]);
    res.json(getForm(tender));
  });

  app.post("/api/application/:id/pdf", async (req, res) => {
    const tender = getTenderById(req.params.id);
    if (!tender) return res.status(404).json({ error: "тендер не найден" });
    const fields = Array.isArray(req.body?.fields)
      ? (req.body.fields as AppField[])
      : getForm(tender).fields;
    try {
      const relPath = await renderApplicationPdf(tender, fields);
      saveForm(tender.id, fields, relPath);
      res.json({ ok: true, pdfUrl: `/files/${relPath}`, form: getForm(tender) });
    } catch (err) {
      logger.error(`PDF generation failed: ${(err as Error).message}`);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/index-docs", (req, res) => {
    if (isRunning()) return res.status(409).json({ error: "Задача уже выполняется" });
    const limit = Number(req.body?.limit) || 100;
    const job = startJob("index-docs", async () => ({ indexed: await indexPendingDocs(limit) }));
    res.json({ started: true, job });
  });

  // --- Настройки / авторизация ---
  app.get("/api/settings", (_req, res) => {
    res.json(settingsView());
  });

  app.put("/api/settings", (req, res) => {
    const body = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (Array.isArray(body.authCookiePairs)) patch.authCookie = assembleCookie(body.authCookiePairs);
    else if (typeof body.authCookie === "string") patch.authCookie = body.authCookie.trim();
    if (body.pollIntervalMinutes != null) patch.pollIntervalMinutes = Number(body.pollIntervalMinutes);
    if (body.enrichPerCycle != null) patch.enrichPerCycle = Number(body.enrichPerCycle);
    if (typeof body.autoEnrich === "boolean") patch.autoEnrich = body.autoEnrich;
    if (typeof body.autoDownloadDocs === "boolean") patch.autoDownloadDocs = body.autoDownloadDocs;
    updateSettings(patch);
    res.json(settingsView());
  });

  app.post("/api/settings/parse-cookies", (req, res) => {
    const raw = String(req.body?.raw ?? "");
    res.json({ pairs: parseCookieDump(raw) });
  });

  app.post("/api/settings/check-auth", async (_req, res) => {
    if (!hasAuth()) return res.json({ authenticated: false, userId: null, note: "Cookie не задан" });
    try {
      const r = await fetcher.checkAuth();
      const note = r.authenticated
        ? ""
        : "Сессия не распознана. Чаще всего не хватает дополнительных кук помимо PHPSESSID — добавьте остальные куки b2b-center.ru из DevTools (Application → Cookies), особенно те, что появляются после входа.";
      res.json({ ...r, note });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // --- Планировщик ---
  app.get("/api/scheduler", (_req, res) => {
    res.json(getSchedulerState());
  });

  app.post("/api/scheduler/start", (req, res) => {
    const interval = req.body?.intervalMinutes != null ? Number(req.body.intervalMinutes) : undefined;
    if (interval) updateSettings({ pollIntervalMinutes: interval });
    res.json(startScheduler(interval ?? getSettings().pollIntervalMinutes));
  });

  app.post("/api/scheduler/stop", (_req, res) => {
    res.json(stopScheduler());
  });

  app.post("/api/scheduler/run-now", (_req, res) => {
    if (getSchedulerState().running) return res.status(409).json({ error: "Цикл уже выполняется" });
    if (isRunning()) return res.status(409).json({ error: "Другая задача уже выполняется" });
    const job = startJob("cycle", () => runCycle());
    res.json({ started: true, job });
  });

  return app;
}

export function startServer(port = Number(process.env.PORT) || 5173): void {
  const app = createServer();
  app.listen(port, () => {
    logger.info(`Веб-интерфейс запущен: http://localhost:${port}`);
  });
}
