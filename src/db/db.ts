import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "../config.js";
import { logger } from "../logger.js";
import type { TenderCard, TenderFile, TenderListItem } from "../types.js";

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenders (
  id              TEXT PRIMARY KEY,
  tsid            TEXT,
  procedure_type  TEXT,
  category        TEXT,
  title           TEXT NOT NULL,
  description     TEXT,
  url             TEXT NOT NULL,
  organizer_name  TEXT,
  organizer_url   TEXT,
  customer_name   TEXT,
  region          TEXT,
  published_at    TEXT,
  actual_until    TEXT,
  end_at          TEXT,
  last_edited_at  TEXT,
  price           TEXT,
  currency        TEXT,
  participants    TEXT,
  payment_terms   TEXT,
  delivery_terms  TEXT,
  status          TEXT,
  requires_auth   INTEGER DEFAULT 0,
  info_rows_json  TEXT,
  card_fetched_at TEXT,
  doc_text        TEXT,
  doc_indexed_at  TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  tender_id   TEXT PRIMARY KEY,
  fields_json TEXT NOT NULL,
  pdf_path    TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tender_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id  TEXT NOT NULL,
  name       TEXT,
  url        TEXT NOT NULL,
  local_path TEXT,
  text       TEXT,
  UNIQUE (tender_id, url)
);

CREATE INDEX IF NOT EXISTS idx_tenders_published ON tenders (published_at);
CREATE INDEX IF NOT EXISTS idx_tenders_status ON tenders (status);
CREATE INDEX IF NOT EXISTS idx_tenders_card_fetched ON tenders (card_fetched_at);
`;

export function getDb(): Database.Database {
  if (db) return db;
  ensureDirs();
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  migrate(db);
  logger.debug(`SQLite ready at ${DB_PATH}`);
  return db;
}

/** Add columns introduced after the initial schema (idempotent). */
function migrate(d: Database.Database): void {
  const tenderCols = new Set((d.prepare("PRAGMA table_info(tenders)").all() as { name: string }[]).map((c) => c.name));
  if (!tenderCols.has("doc_text")) d.exec("ALTER TABLE tenders ADD COLUMN doc_text TEXT");
  if (!tenderCols.has("doc_indexed_at")) d.exec("ALTER TABLE tenders ADD COLUMN doc_indexed_at TEXT");
  if (!tenderCols.has("match_notified_at")) d.exec("ALTER TABLE tenders ADD COLUMN match_notified_at TEXT");
  const fileCols = new Set((d.prepare("PRAGMA table_info(tender_files)").all() as { name: string }[]).map((c) => c.name));
  if (!fileCols.has("text")) d.exec("ALTER TABLE tender_files ADD COLUMN text TEXT");
}

/** Insert or update a tender from a search-list row. Preserves card data. */
export function upsertListItem(item: TenderListItem): "inserted" | "updated" {
  const d = getDb();
  const now = item.scrapedAt;
  const exists = d.prepare("SELECT id FROM tenders WHERE id = ?").get(item.id);
  if (exists) {
    d.prepare(
      `UPDATE tenders SET
         tsid = COALESCE(?, tsid),
         procedure_type = COALESCE(?, procedure_type),
         category = COALESCE(?, category),
         title = ?,
         description = COALESCE(?, description),
         url = ?,
         organizer_name = COALESCE(?, organizer_name),
         organizer_url = COALESCE(?, organizer_url),
         published_at = COALESCE(?, published_at),
         actual_until = COALESCE(?, actual_until),
         status = ?,
         last_seen_at = ?
       WHERE id = ?`,
    ).run(
      item.tsid,
      item.procedureType,
      item.category,
      item.title,
      item.description,
      item.url,
      item.organizerName,
      item.organizerUrl,
      item.publishedAt,
      item.actualUntil,
      item.status,
      now,
      item.id,
    );
    return "updated";
  }
  d.prepare(
    `INSERT INTO tenders
       (id, tsid, procedure_type, category, title, description, url,
        organizer_name, organizer_url, published_at, actual_until, status,
        first_seen_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    item.id,
    item.tsid,
    item.procedureType,
    item.category,
    item.title,
    item.description,
    item.url,
    item.organizerName,
    item.organizerUrl,
    item.publishedAt,
    item.actualUntil,
    item.status,
    now,
    now,
  );
  return "inserted";
}

/** Merge detailed card data into a tender row, inserting a stub if it's new. */
export function saveCard(card: TenderCard): void {
  const d = getDb();
  const now = card.fetchedAt;
  const exists = d.prepare("SELECT id FROM tenders WHERE id = ?").get(card.id);
  if (!exists) {
    d.prepare(
      `INSERT INTO tenders (id, title, url, status, first_seen_at, last_seen_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(card.id, card.title ?? `Процедура № ${card.id}`, card.url, "actual", now, now);
  }
  d.prepare(
    `UPDATE tenders SET
       procedure_type = COALESCE(?, procedure_type),
       title = COALESCE(?, title),
       organizer_name = COALESCE(?, organizer_name),
       customer_name = COALESCE(?, customer_name),
       region = COALESCE(?, region),
       category = COALESCE(?, category),
       published_at = COALESCE(?, published_at),
       end_at = COALESCE(?, end_at),
       last_edited_at = COALESCE(?, last_edited_at),
       price = COALESCE(?, price),
       currency = COALESCE(?, currency),
       participants = COALESCE(?, participants),
       payment_terms = COALESCE(?, payment_terms),
       delivery_terms = COALESCE(?, delivery_terms),
       requires_auth = ?,
       info_rows_json = ?,
       card_fetched_at = ?
     WHERE id = ?`,
  ).run(
    card.procedureType,
    card.title,
    card.organizerName,
    card.customerName,
    card.region,
    card.category,
    card.publishedAt,
    card.endAt,
    card.lastEditedAt,
    card.price,
    card.currency,
    card.participants,
    card.paymentTerms,
    card.deliveryTerms,
    card.requiresAuth ? 1 : 0,
    JSON.stringify(card.infoRows),
    card.fetchedAt,
    card.id,
  );
  for (const f of card.files) saveFile(card.id, f);
}

export function saveFile(tenderId: string, file: TenderFile): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO tender_files (tender_id, name, url, local_path)
     VALUES (?,?,?,?)
     ON CONFLICT (tender_id, url) DO UPDATE SET
       name = excluded.name,
       local_path = COALESCE(excluded.local_path, tender_files.local_path)`,
  ).run(tenderId, file.name, file.url, file.localPath);
}

export interface TenderRow {
  id: string;
  tsid: string | null;
  procedure_type: string | null;
  category: string | null;
  title: string;
  description: string | null;
  url: string;
  organizer_name: string | null;
  customer_name: string | null;
  region: string | null;
  published_at: string | null;
  actual_until: string | null;
  end_at: string | null;
  price: string | null;
  currency: string | null;
  participants: string | null;
  payment_terms: string | null;
  delivery_terms: string | null;
  status: string | null;
  requires_auth: number;
  info_rows_json: string | null;
  card_fetched_at: string | null;
  doc_text: string | null;
  doc_indexed_at: string | null;
  match_notified_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export function getAllTenders(): TenderRow[] {
  return getDb().prepare("SELECT * FROM tenders ORDER BY published_at DESC").all() as TenderRow[];
}

export interface TenderQuery {
  q?: string;
  status?: string;
  hasCard?: boolean;
  sort?: "published" | "end";
  limit?: number;
  offset?: number;
}

/** Filtered/sorted tender query for the UI. */
export function queryTenders(opts: TenderQuery = {}): TenderRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.q) {
    where.push("(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(category) LIKE ? OR LOWER(organizer_name) LIKE ?)");
    const like = `%${opts.q.toLowerCase()}%`;
    params.push(like, like, like, like);
  }
  if (opts.status && opts.status !== "all") {
    where.push("status = ?");
    params.push(opts.status);
  }
  if (opts.hasCard === true) where.push("card_fetched_at IS NOT NULL");
  if (opts.hasCard === false) where.push("card_fetched_at IS NULL");

  const orderCol = opts.sort === "end" ? "COALESCE(end_at, actual_until)" : "published_at";
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
  const offset = Math.max(opts.offset ?? 0, 0);

  const sql =
    `SELECT * FROM tenders` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return getDb().prepare(sql).all(...params) as TenderRow[];
}

export interface TenderFileRow {
  name: string | null;
  url: string;
  local_path: string | null;
}

export function getTenderById(id: string): TenderRow | undefined {
  return getDb().prepare("SELECT * FROM tenders WHERE id = ?").get(id) as TenderRow | undefined;
}

export function getTenderFiles(tenderId: string): TenderFileRow[] {
  return getDb()
    .prepare("SELECT name, url, local_path FROM tender_files WHERE tender_id = ?")
    .all(tenderId) as TenderFileRow[];
}

/** Store extracted text for a single downloaded file. */
export function saveFileText(tenderId: string, url: string, text: string): void {
  getDb().prepare("UPDATE tender_files SET text = ? WHERE tender_id = ? AND url = ?").run(text, tenderId, url);
}

/** Store the aggregated documentation text for a tender and mark it indexed. */
export function saveDocText(tenderId: string, text: string): void {
  getDb()
    .prepare("UPDATE tenders SET doc_text = ?, doc_indexed_at = ? WHERE id = ?")
    .run(text, new Date().toISOString(), tenderId);
}

export interface ApplicationRow {
  tender_id: string;
  fields_json: string;
  pdf_path: string | null;
  updated_at: string;
}

export function getApplication(tenderId: string): ApplicationRow | undefined {
  return getDb().prepare("SELECT * FROM applications WHERE tender_id = ?").get(tenderId) as
    | ApplicationRow
    | undefined;
}

export function saveApplication(tenderId: string, fieldsJson: string, pdfPath?: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO applications (tender_id, fields_json, pdf_path, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(tender_id) DO UPDATE SET
         fields_json = excluded.fields_json,
         pdf_path = COALESCE(excluded.pdf_path, applications.pdf_path),
         updated_at = excluded.updated_at`,
    )
    .run(tenderId, fieldsJson, pdfPath ?? null, new Date().toISOString());
}

/** Mark a tender as already announced as a new match. */
export function markMatchNotified(id: string): void {
  getDb().prepare("UPDATE tenders SET match_notified_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

/** Tenders that have downloaded files but no aggregated doc text yet. */
export function getTendersNeedingDocIndex(limit = 100): TenderRow[] {
  return getDb()
    .prepare(
      `SELECT t.* FROM tenders t
       WHERE t.doc_indexed_at IS NULL
         AND EXISTS (SELECT 1 FROM tender_files f WHERE f.tender_id = t.id AND f.local_path IS NOT NULL)
       ORDER BY t.published_at DESC LIMIT ?`,
    )
    .all(limit) as TenderRow[];
}

export function getTendersWithoutCard(limit = 100): TenderRow[] {
  return getDb()
    .prepare("SELECT * FROM tenders WHERE card_fetched_at IS NULL ORDER BY published_at DESC LIMIT ?")
    .all(limit) as TenderRow[];
}

export function countTenders(): { total: number; withCard: number } {
  const d = getDb();
  const total = (d.prepare("SELECT COUNT(*) c FROM tenders").get() as { c: number }).c;
  const withCard = (
    d.prepare("SELECT COUNT(*) c FROM tenders WHERE card_fetched_at IS NOT NULL").get() as { c: number }
  ).c;
  return { total, withCard };
}
