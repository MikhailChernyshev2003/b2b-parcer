import { loadCriteriaSafe } from "./criteria/criteria.js";
import { evaluate } from "./criteria/matcher.js";
import { getAllTenders, markMatchNotified } from "./db/db.js";
import { logger } from "./logger.js";
import { enrichCards } from "./scraper/cardScraper.js";
import { indexPendingDocs } from "./scraper/docs.js";
import { scrapeFeed, scrapeQueries, type ScrapeSummary } from "./scraper/marketScraper.js";
import { getSettings } from "./settings.js";
import { describeAuth, ensureSession } from "./authStatus.js";
import type { SearchQuery } from "./types.js";

export interface CycleResult {
  startedAt: string;
  finishedAt: string;
  scraped: number;
  enriched: number;
  indexed: number;
  matches: number;
  newMatches: { id: string; title: string; score: number; url: string }[];
}

export interface SchedulerState {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  cycles: number;
  lastResult: CycleResult | null;
  lastError: string | null;
  log: string[];
}

const MAX_LOG = 200;

const state: SchedulerState = {
  enabled: false,
  running: false,
  intervalMinutes: 30,
  lastRunAt: null,
  nextRunAt: null,
  cycles: 0,
  lastResult: null,
  lastError: null,
  log: [],
};

let timer: NodeJS.Timeout | null = null;

function slog(line: string): void {
  const stamped = `[${new Date().toISOString().replace("T", " ").replace("Z", "")}] ${line}`;
  state.log.push(stamped);
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

export function getSchedulerState(): SchedulerState {
  return state;
}

/**
 * One full pass: scrape by criteria keywords -> enrich new cards (+docs) ->
 * index documentation -> evaluate -> announce new matches.
 */
export async function runCycle(): Promise<CycleResult> {
  const startedAt = new Date().toISOString();
  state.running = true;
  const settings = getSettings();
  const criteria = loadCriteriaSafe();
  slog(`Цикл старт. Авторизация: ${describeAuth(await ensureSession())}`);

  // 1. Collect the list: the whole newest-first feed when the search session is
  //    authenticated, otherwise (guest, 20 rows per query) one query per keyword.
  let scrapeSummary: ScrapeSummary = await scrapeFeed({ status: "actual", trade: "buy" });
  if (scrapeSummary.mode === "guest") {
    slog("Поиск в гостевом режиме — сбор по ключевым словам (20 результатов на запрос)");
    const keywords = criteria.keywordsAny.length ? criteria.keywordsAny : [];
    const queries: SearchQuery[] = keywords.length
      ? keywords.map((k) => ({ status: "actual", trade: "buy", keyword: k }))
      : [{ status: "actual", trade: "buy" }];
    scrapeSummary = await scrapeQueries(queries);
  }
  slog(`Сбор: новых ${scrapeSummary.inserted}, обновлено ${scrapeSummary.updated}, режим сайта: ${scrapeSummary.mode ?? "?"}`);
  if (scrapeSummary.fetched === 0) {
    slog(`ВНИМАНИЕ: сбор не вернул ни одной записи — возможно, изменился API B2B-Center`);
  }

  // 2. Enrich cards (+ documentation) for tenders missing details.
  let enriched = 0;
  if (settings.autoEnrich) {
    // Only criteria matches get a card: the feed brings ~1000 tenders a day.
    enriched = await enrichCards(settings.enrichPerCycle, {
      downloadFiles: settings.autoDownloadDocs,
      only: (t) => evaluate(t, criteria).matched,
    });
    slog(`Карточек обработано: ${enriched}`);
  }

  // 3. Make sure documentation text is aggregated.
  let indexed = 0;
  if (settings.autoDownloadDocs) {
    indexed = await indexPendingDocs(settings.enrichPerCycle);
    slog(`Документация проиндексирована: ${indexed}`);
  }

  // 4. Evaluate everything; announce matches we haven't announced yet.
  const tenders = getAllTenders();
  const newMatches: CycleResult["newMatches"] = [];
  let matches = 0;
  for (const t of tenders) {
    const e = evaluate(t, criteria);
    if (!e.matched) continue;
    matches++;
    if (!t.match_notified_at) {
      markMatchNotified(t.id);
      newMatches.push({ id: t.id, title: t.title, score: e.score, url: t.url });
      slog(`НОВЫЙ ПОДХОДЯЩИЙ [${e.score}] № ${t.id} — ${t.title}`);
    }
  }
  slog(`Совпадений всего: ${matches}, новых: ${newMatches.length}`);

  const finishedAt = new Date().toISOString();
  const result: CycleResult = {
    startedAt,
    finishedAt,
    scraped: scrapeSummary.inserted,
    enriched,
    indexed,
    matches,
    newMatches,
  };
  state.running = false;
  state.lastRunAt = finishedAt;
  state.cycles++;
  state.lastResult = result;
  state.lastError = null;
  return result;
}

async function tick(): Promise<void> {
  if (state.running) {
    slog("Пропуск тика: предыдущий цикл ещё выполняется");
    return;
  }
  try {
    await runCycle();
  } catch (err) {
    state.running = false;
    state.lastError = (err as Error).message;
    slog(`ОШИБКА цикла: ${(err as Error).message}`);
    logger.error(`Scheduler cycle failed: ${(err as Error).stack || err}`);
  } finally {
    if (state.enabled) {
      state.nextRunAt = new Date(Date.now() + state.intervalMinutes * 60_000).toISOString();
    }
  }
}

/** Start periodic execution. Runs the first cycle immediately. */
export function startScheduler(intervalMinutes?: number): SchedulerState {
  if (state.enabled) return state;
  state.intervalMinutes = intervalMinutes ?? getSettings().pollIntervalMinutes;
  state.enabled = true;
  state.nextRunAt = new Date().toISOString();
  slog(`Планировщик запущен, интервал ${state.intervalMinutes} мин`);
  void tick();
  timer = setInterval(() => void tick(), state.intervalMinutes * 60_000);
  if (typeof timer.unref === "function") timer.unref();
  return state;
}

export function stopScheduler(): SchedulerState {
  state.enabled = false;
  state.nextRunAt = null;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  slog("Планировщик остановлен");
  return state;
}
