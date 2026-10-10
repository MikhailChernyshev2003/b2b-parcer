import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PROJECT_ROOT } from "../config.js";

/**
 * User-defined selection criteria. Loaded from a YAML (or JSON) file.
 * All sections are optional; an empty config matches everything with score 0.
 */
export const CriteriaSchema = z.object({
  /** Match if the tender text contains ANY of these (OR). */
  keywordsAny: z.array(z.string()).default([]),
  /** Require ALL of these to be present (AND). */
  keywordsAll: z.array(z.string()).default([]),
  /** Reject the tender if ANY of these appear (stop-words). */
  exclude: z.array(z.string()).default([]),
  /** Restrict to these categories (substring match, OR). Empty = any. */
  categoriesAny: z.array(z.string()).default([]),
  /** Restrict to these regions (substring match, OR). Empty = any. */
  regionsAny: z.array(z.string()).default([]),
  /** Only these procedure types (substring match, OR). Empty = any. */
  procedureTypesAny: z.array(z.string()).default([]),
  /** Reject if organizer matches any of these (substring). */
  organizersExclude: z.array(z.string()).default([]),
  /**
   * Classifier codes (ОКПД2 / ОКВЭД-формат, например "28.13" или "28.13.14").
   * Совпадение, если код тендера начинается с одного из указанных префиксов.
   * Empty = не учитывается.
   */
  classifierCodes: z.array(z.string()).default([]),
  /** Содержимое документации: совпадение, если есть ХОТЯ БЫ ОДНО (OR). */
  docKeywordsAny: z.array(z.string()).default([]),
  /** Содержимое документации: должны присутствовать ВСЕ (AND). */
  docKeywordsAll: z.array(z.string()).default([]),
  /** Содержимое документации: отбраковать, если встречается любое. */
  docExclude: z.array(z.string()).default([]),
  /** Numeric price bounds (parsed from the card price text, in rubles). */
  priceMin: z.number().optional(),
  priceMax: z.number().optional(),
  /** Require at least N days remaining until the submission deadline. */
  minDaysUntilEnd: z.number().optional(),
  /** Scoring weights. */
  weights: z
    .object({
      keywordAny: z.number().default(2),
      keywordAll: z.number().default(3),
      category: z.number().default(2),
      region: z.number().default(1),
      procedureType: z.number().default(1),
      priceInRange: z.number().default(1),
      classifierCode: z.number().default(3),
      docKeywordAny: z.number().default(2),
      docKeywordAll: z.number().default(3),
    })
    .default({}),
  /** Minimum score for a tender to be considered a match. */
  minScore: z.number().default(1),
});

export type Criteria = z.infer<typeof CriteriaSchema>;

const DEFAULT_PATHS = [
  process.env.B2B_CRITERIA_PATH,
  path.join(PROJECT_ROOT, "config", "criteria.yaml"),
  path.join(PROJECT_ROOT, "config", "criteria.yml"),
  path.join(PROJECT_ROOT, "config", "criteria.json"),
].filter(Boolean) as string[];

export function loadCriteria(explicitPath?: string): Criteria {
  const candidates = explicitPath ? [explicitPath] : DEFAULT_PATHS;
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `Файл критериев не найден. Создайте config/criteria.yaml (пример: config/criteria.example.yaml) ` +
        `или укажите путь через B2B_CRITERIA_PATH.`,
    );
  }
  const raw = fs.readFileSync(found, "utf-8");
  const data = found.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
  return CriteriaSchema.parse(data ?? {});
}

/** Default writable criteria path (config/criteria.yaml). */
export function criteriaFilePath(): string {
  return process.env.B2B_CRITERIA_PATH || path.join(PROJECT_ROOT, "config", "criteria.yaml");
}

/** Like loadCriteria, but returns schema defaults if no file exists. */
export function loadCriteriaSafe(explicitPath?: string): Criteria {
  try {
    return loadCriteria(explicitPath);
  } catch {
    return CriteriaSchema.parse({});
  }
}

/** Validate and persist criteria to config/criteria.yaml. */
export function saveCriteria(input: unknown, explicitPath?: string): Criteria {
  const parsed = CriteriaSchema.parse(input ?? {});
  const target = explicitPath || criteriaFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, YAML.stringify(parsed), "utf-8");
  return parsed;
}
