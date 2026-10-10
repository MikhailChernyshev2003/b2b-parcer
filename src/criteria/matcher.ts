import type { TenderRow } from "../db/db.js";
import type { Criteria } from "./criteria.js";
import { matchAny, prepareText, type PreparedText } from "./textmatch.js";

export interface MatchResult {
  tender: TenderRow;
  score: number;
  matched: boolean;
  reasons: string[];
  rejectedBy: string | null;
}

/** Build a single lowercase haystack from the tender's text fields. */
function haystack(t: TenderRow): string {
  return [t.title, t.description, t.category, t.procedure_type, t.organizer_name, t.region]
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();
}

/** Text that may contain classifier codes (category + raw info rows). */
function codeText(t: TenderRow): string {
  return [t.category, t.info_rows_json].filter(Boolean).join(" ");
}

/** All classifier-like codes ("28.12.13.110", "46.71") found in a text. */
function extractCodes(text: string): string[] {
  return text.match(/\d{2}(?:\.\d{1,3}){1,5}/g) ?? [];
}

/** True if any code in `codes` equals or is nested under one of `prefixes`. */
function codeMatches(codes: string[], prefixes: string[]): string[] {
  const hits: string[] = [];
  for (const p of prefixes) {
    const pref = p.trim();
    if (!pref) continue;
    if (codes.some((c) => c === pref || c.startsWith(pref + "."))) hits.push(pref);
  }
  return hits;
}

/** Parse a numeric ruble amount out of a free-form price string. */
export function parsePrice(price: string | null): number | null {
  if (!price) return null;
  const digits = price.replace(/[^\d.,]/g, "").replace(/\s/g, "").replace(",", ".");
  const cleaned = digits.replace(/\.(?=\d{3}\b)/g, ""); // strip thousand dots
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function daysUntil(dateIso: string | null): number | null {
  if (!dateIso) return null;
  const t = Date.parse(dateIso);
  if (Number.isNaN(t)) return null;
  return (t - Date.now()) / 86_400_000;
}

function containsAny(hay: string, needles: string[]): string[] {
  return needles.filter((n) => n.trim() && hay.includes(n.toLowerCase()));
}

/** Morphology-aware variant of containsAny for a raw text field. */
function morphAny(text: string, needles: string[]): string[] {
  if (!needles.length || !text) return [];
  return matchAny(prepareText(text), needles);
}

// Prepared doc texts are cached: they are large and criteria are re-evaluated
// on every API request over the same rows.
const docPrepCache = new Map<string, PreparedText>();

function prepareDoc(tenderId: string, docText: string): PreparedText {
  const key = `${tenderId}:${docText.length}`;
  let p = docPrepCache.get(key);
  if (!p) {
    p = prepareText(docText);
    if (docPrepCache.size > 500) docPrepCache.clear();
    docPrepCache.set(key, p);
  }
  return p;
}

/** Evaluate a tender against the criteria, returning score + explanation. */
export function evaluate(tender: TenderRow, c: Criteria): MatchResult {
  const hay = prepareText(haystack(tender));
  const reasons: string[] = [];
  let score = 0;

  // Hard rejections first.
  const hitExclude = matchAny(hay, c.exclude);
  if (hitExclude.length) {
    return { tender, score: 0, matched: false, reasons, rejectedBy: `стоп-слово: ${hitExclude.join(", ")}` };
  }

  if (c.keywordsAll.length) {
    const present = new Set(matchAny(hay, c.keywordsAll));
    const missing = c.keywordsAll.filter((k) => !present.has(k));
    if (missing.length) {
      return { tender, score: 0, matched: false, reasons, rejectedBy: `нет обязательных слов: ${missing.join(", ")}` };
    }
    score += c.weights.keywordAll * c.keywordsAll.length;
    reasons.push(`все обязательные слова присутствуют (${c.keywordsAll.join(", ")})`);
  }

  // For ANY-restrictions the tender is rejected only when the field is known
  // and does not match; an empty field (list item without a card yet) passes
  // through without points.
  if (c.categoriesAny.length && tender.category) {
    const hit = morphAny(tender.category, c.categoriesAny);
    if (!hit.length) return { tender, score: 0, matched: false, reasons, rejectedBy: "категория не подходит" };
    score += c.weights.category;
    reasons.push(`категория: ${hit.join(", ")}`);
  }

  if (c.regionsAny.length && tender.region) {
    const hit = morphAny(tender.region, c.regionsAny);
    if (!hit.length) return { tender, score: 0, matched: false, reasons, rejectedBy: "регион не подходит" };
    score += c.weights.region;
    reasons.push(`регион: ${hit.join(", ")}`);
  }

  if (c.procedureTypesAny.length && tender.procedure_type) {
    const hit = containsAny(tender.procedure_type.toLowerCase(), c.procedureTypesAny);
    if (!hit.length) return { tender, score: 0, matched: false, reasons, rejectedBy: "тип процедуры не подходит" };
    score += c.weights.procedureType;
    reasons.push(`тип процедуры: ${hit.join(", ")}`);
  }

  if (c.organizersExclude.length) {
    const hit = containsAny((tender.organizer_name ?? "").toLowerCase(), c.organizersExclude);
    if (hit.length) return { tender, score: 0, matched: false, reasons, rejectedBy: `организатор исключён: ${hit.join(", ")}` };
  }

  if (c.classifierCodes.length) {
    const codes = extractCodes(codeText(tender));
    const hit = codeMatches(codes, c.classifierCodes);
    if (!hit.length) {
      return { tender, score: 0, matched: false, reasons, rejectedBy: "код ОКПД2/ОКВЭД не подходит" };
    }
    score += c.weights.classifierCode * hit.length;
    reasons.push(`код ОКПД2/ОКВЭД: ${hit.join(", ")}`);
  }

  // --- Документация (по извлечённому тексту файлов) ---
  // docKeywordsAll / docExclude are mandatory checks: without analyzed docs the
  // tender is parked as "not analyzed". docKeywordsAny is bonus scoring only,
  // so missing documentation does not reject the tender.
  const docText = tender.doc_text ?? "";
  const docMandatory = c.docExclude.length > 0 || c.docKeywordsAll.length > 0;
  const docNeeded = docMandatory || c.docKeywordsAny.length > 0;
  if (docMandatory && !docText) {
    return { tender, score: 0, matched: false, reasons, rejectedBy: "документация не проанализирована" };
  }
  if (docText && docNeeded) {
    const doc = prepareDoc(tender.id, docText);
    const docHitExclude = matchAny(doc, c.docExclude);
    if (docHitExclude.length) {
      return { tender, score: 0, matched: false, reasons, rejectedBy: `стоп-слово в документации: ${docHitExclude.join(", ")}` };
    }
    if (c.docKeywordsAll.length) {
      const present = new Set(matchAny(doc, c.docKeywordsAll));
      const missing = c.docKeywordsAll.filter((k) => !present.has(k));
      if (missing.length) {
        return { tender, score: 0, matched: false, reasons, rejectedBy: `в документации нет обязательных слов: ${missing.join(", ")}` };
      }
      score += c.weights.docKeywordAll * c.docKeywordsAll.length;
      reasons.push(`документация: все обязательные слова присутствуют`);
    }
    const docHitAny = matchAny(doc, c.docKeywordsAny);
    if (docHitAny.length) {
      score += c.weights.docKeywordAny * docHitAny.length;
      reasons.push(`документация: ${docHitAny.join(", ")}`);
    }
  }

  if (c.minDaysUntilEnd != null) {
    const left = daysUntil(tender.end_at) ?? daysUntil(tender.actual_until);
    if (left != null && left < c.minDaysUntilEnd) {
      return { tender, score: 0, matched: false, reasons, rejectedBy: `мало времени до окончания (${left.toFixed(1)} дн.)` };
    }
  }

  const price = parsePrice(tender.price);
  if (c.priceMin != null || c.priceMax != null) {
    if (price != null) {
      if (c.priceMin != null && price < c.priceMin) {
        return { tender, score: 0, matched: false, reasons, rejectedBy: `цена ниже минимума (${price})` };
      }
      if (c.priceMax != null && price > c.priceMax) {
        return { tender, score: 0, matched: false, reasons, rejectedBy: `цена выше максимума (${price})` };
      }
      score += c.weights.priceInRange;
      reasons.push(`цена в диапазоне (${price.toLocaleString("ru-RU")} ₽)`);
    }
  }

  const hitAny = matchAny(hay, c.keywordsAny);
  if (hitAny.length) {
    score += c.weights.keywordAny * hitAny.length;
    reasons.push(`ключевые слова: ${hitAny.join(", ")}`);
  }

  const matched = score >= c.minScore;
  return { tender, score, matched, reasons, rejectedBy: matched ? null : "ниже порога score" };
}

/** Evaluate and rank a list of tenders; returns only matches, highest score first. */
export function selectMatches(tenders: TenderRow[], c: Criteria): MatchResult[] {
  return tenders
    .map((t) => evaluate(t, c))
    .filter((r) => r.matched)
    .sort((a, b) => b.score - a.score);
}
