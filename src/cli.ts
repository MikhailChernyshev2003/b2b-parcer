import { loadCriteria } from "./criteria/criteria.js";
import { selectMatches } from "./criteria/matcher.js";
import { printReport, writeReport } from "./criteria/report.js";
import { countTenders, getAllTenders } from "./db/db.js";
import { logger } from "./logger.js";
import { enrichCards, fetchCard } from "./scraper/cardScraper.js";
import { scrapeQueries, sliceByDay } from "./scraper/marketScraper.js";
import type { MarketStatus, SearchQuery } from "./types.js";
import { hasAuth } from "./settings.js";
import { startServer } from "./server/server.js";
import { indexPendingDocs } from "./scraper/docs.js";
import { runCycle, startScheduler } from "./scheduler.js";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function collectKeywords(flags: Record<string, string | boolean>): string[] {
  const out: string[] = [];
  if (typeof flags.keyword === "string") out.push(...flags.keyword.split(",").map((s) => s.trim()).filter(Boolean));
  return out;
}

function statusOf(flags: Record<string, string | boolean>): MarketStatus {
  if (flags.archive) return "archive";
  if (flags.all) return "all";
  if (typeof flags.status === "string") return flags.status as MarketStatus;
  return "actual";
}

async function cmdScrape(args: Args): Promise<void> {
  const status = statusOf(args.flags);
  let keywords = collectKeywords(args.flags);

  // Fall back to criteria keywords if none given on the CLI.
  if (!keywords.length) {
    try {
      const c = loadCriteria(typeof args.flags.criteria === "string" ? args.flags.criteria : undefined);
      keywords = c.keywordsAny;
    } catch {
      /* no criteria file -> single default query below */
    }
  }

  const base: SearchQuery = { status, trade: "all" };
  if (args.flags.buy) base.trade = "buy";
  if (args.flags.sell) base.trade = "sell";

  let queries: SearchQuery[];
  if (keywords.length) {
    queries = keywords.map((k) => ({ ...base, keyword: k }));
  } else {
    queries = [base];
  }

  // Optional date-window slicing (guest-mode breadth).
  const from = typeof args.flags["date-from"] === "string" ? (args.flags["date-from"] as string) : undefined;
  const to = typeof args.flags["date-to"] === "string" ? (args.flags["date-to"] as string) : undefined;
  if (from && to) {
    queries = queries.flatMap((q) => sliceByDay({ ...q, dateMode: "published" }, from, to));
  }

  logger.info(`Запуск парсинга: запросов=${queries.length}, статус=${status}, авторизация=${hasAuth() ? "да" : "нет (гость)"}`);
  const summary = await scrapeQueries(queries, {
    maxPages: typeof args.flags.pages === "string" ? Number(args.flags.pages) : undefined,
  });
  logger.info(
    `Готово. Получено строк: ${summary.fetched}, уникальных id: ${summary.uniqueIds}, новых: ${summary.inserted}, обновлено: ${summary.updated}`,
  );
}

async function cmdCard(args: Args): Promise<void> {
  const downloadFiles = Boolean(args.flags.files);
  if (typeof args.flags.url === "string") {
    await fetchCard(args.flags.url, { downloadFiles });
    return;
  }
  const limit = typeof args.flags.limit === "string" ? Number(args.flags.limit) : 20;
  const ok = await enrichCards(limit, { downloadFiles });
  logger.info(`Обработано карточек: ${ok}`);
}

function cmdReport(args: Args): void {
  const c = loadCriteria(typeof args.flags.criteria === "string" ? args.flags.criteria : undefined);
  const tenders = getAllTenders();
  const matches = selectMatches(tenders, c);
  printReport(matches, typeof args.flags.top === "string" ? Number(args.flags.top) : 20);
  const paths = writeReport(matches);
  console.log(`Отчёт сохранён: ${paths.json}\n            и: ${paths.csv}\n`);
}

function cmdStats(): void {
  const { total, withCard } = countTenders();
  console.log(`\nВсего тендеров в базе: ${total}`);
  console.log(`С загруженной карточкой: ${withCard}`);
  console.log(`БД: ${hasAuth() ? "(сессия авторизована)" : "(гостевая сессия)"}\n`);
}

function printHelp(): void {
  console.log(`
b2b-parcer — парсер тендеров B2B-Center (сторона поставщика)

Использование:
  npm run scrape -- [--keyword "насосы,трубы"] [--archive|--all] [--buy|--sell]
                    [--date-from dd.mm.yyyy --date-to dd.mm.yyyy] [--pages N]
                    [--criteria path]
      Сбор списка процедур. Без --keyword берёт ключевые слова из criteria.yaml.
      Для гостя пагинация недоступна — охват достигается ключевыми словами и
      нарезкой по датам. С B2B_AUTH_COOKIE доступны страницы (--pages).

  npm run card -- --url <url карточки> [--files]
  npm run card -- [--limit N] [--files]
      Загрузка детальных карточек. Без --url добирает N тендеров без карточки.
      --files скачивает доступную документацию в data/files/<id>/.

  npm run report -- [--criteria path] [--top N]
      Оценка тендеров по критериям, печать топа и выгрузка data/report.{json,csv}.

  npm run stats
      Счётчики базы.

  npm run serve -- [--port 5173]
      Веб-интерфейс: фильтры, критерии, список тендеров, карточки, запуск сбора.

  tsx src/index.ts index-docs [--limit N]
      Извлечь текст из скачанной документации и проиндексировать.

  tsx src/index.ts watch [--interval 30] [--once]
      Периодический цикл: сбор -> карточки -> документация -> отбор новых
      подходящих тендеров. --once выполняет один цикл и выходит.

Переменные окружения:
  B2B_AUTH_COOKIE       cookie авторизованной сессии (включает пагинацию)
  B2B_REQUEST_DELAY_MS  задержка между запросами (по умолчанию 1500)
  B2B_CRITERIA_PATH     путь к файлу критериев
  LOG_LEVEL             debug|info|warn|error
`);
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  switch (cmd) {
    case "scrape":
      await cmdScrape(args);
      break;
    case "card":
      await cmdCard(args);
      break;
    case "report":
      cmdReport(args);
      break;
    case "stats":
      cmdStats();
      break;
    case "serve":
      startServer(typeof args.flags.port === "string" ? Number(args.flags.port) : undefined);
      break;
    case "index-docs":
      await indexPendingDocs(typeof args.flags.limit === "string" ? Number(args.flags.limit) : 100);
      break;
    case "watch":
      if (args.flags.once) {
        await runCycle();
      } else {
        startScheduler(typeof args.flags.interval === "string" ? Number(args.flags.interval) : undefined);
        await new Promise(() => {}); // keep process alive
      }
      break;
    case "help":
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Неизвестная команда: ${cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}
