import { getApplication, saveApplication, type TenderRow } from "../db/db.js";

/** One input of the application form. */
export interface AppField {
  id: string;
  label: string;
  value: string;
  /** standard — реквизиты компании/КП; doc — извлечено из документации; custom — добавлено вручную. */
  source: "standard" | "doc" | "custom";
  multiline?: boolean;
}

export interface AppForm {
  tenderId: string;
  fields: AppField[];
  updatedAt: string | null;
  pdfPath: string | null;
}

/** Typical requisites of a Russian commercial bid (КП / заявка на участие). */
const STANDARD_FIELDS: Omit<AppField, "value">[] = [
  { id: "company", label: "Наименование организации", source: "standard" },
  { id: "inn", label: "ИНН / КПП", source: "standard" },
  { id: "ogrn", label: "ОГРН", source: "standard" },
  { id: "address", label: "Юридический адрес", source: "standard" },
  { id: "contact", label: "Контактное лицо (ФИО, должность)", source: "standard" },
  { id: "phone", label: "Телефон", source: "standard" },
  { id: "email", label: "Email", source: "standard" },
  { id: "price", label: "Предлагаемая цена, руб. (с НДС / без НДС)", source: "standard" },
  { id: "term", label: "Срок выполнения работ / оказания услуг", source: "standard" },
  { id: "payment", label: "Условия оплаты (отсрочка, этапы)", source: "standard" },
  { id: "warranty", label: "Гарантийные обязательства", source: "standard" },
  { id: "validity", label: "Срок действия предложения", source: "standard" },
  { id: "cover", label: "Сопроводительный текст / комментарий", source: "standard", multiline: true },
];

/** Markers preceding the list of what the customer wants in the bid. */
const SECTION_MARKERS =
  /(состав[еуа]?\s+заявки|в\s+составе\s+заявки|заявка\s+должна\s+содержать|необходимо\s+предоставить|должн[оаы]\s+(?:быть\s+)?(?:предоставлен|содержать|приложен)|перечень\s+документов|требования\s+к\s+участник\w*|в\s+кп\s+(?:необходимо\s+)?указать|коммерческое\s+предложение\s+должно\s+содержать|обязательн\w*\s+условие|к\s+заявке\s+прилага)/gi;

/** Pull requirement bullet points that follow section markers in doc text. */
export function extractRequirements(docText: string, maxItems = 15): string[] {
  if (!docText) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const m of docText.matchAll(SECTION_MARKERS)) {
    const start = m.index! + m[0].length;
    const window = docText.slice(start, start + 1200);
    // Items look like numbered/bulleted lines or short semicolon-separated clauses.
    const lines = window
      .split(/\n|(?<=;)/)
      .map((l) => l.replace(/^[\s\d.)–\-•·*]+/, "").replace(/[;.\s]+$/, "").trim())
      .filter((l) => l.length >= 15 && l.length <= 220);
    for (const line of lines.slice(0, 8)) {
      // Skip page headers / table junk / pure numbers.
      if (/^\d+$/.test(line) || /страница|лист \d/i.test(line)) continue;
      // Mid-sentence fragments start with a lowercase letter — not a requirement.
      if (/^[а-яёa-z]/.test(line)) continue;
      const key = line.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
      if (out.length >= maxItems) return out;
    }
  }
  return out;
}

/** Build the form: saved draft, or defaults + requirements mined from docs. */
export function getForm(tender: TenderRow): AppForm {
  const saved = getApplication(tender.id);
  if (saved) {
    return {
      tenderId: tender.id,
      fields: JSON.parse(saved.fields_json) as AppField[],
      updatedAt: saved.updated_at,
      pdfPath: saved.pdf_path,
    };
  }
  const fields: AppField[] = STANDARD_FIELDS.map((f) => ({ ...f, value: "" }));
  extractRequirements(tender.doc_text ?? "").forEach((req, i) => {
    fields.push({ id: `doc${i}`, label: req, value: "", source: "doc", multiline: true });
  });
  return { tenderId: tender.id, fields, updatedAt: null, pdfPath: null };
}

export function saveForm(tenderId: string, fields: AppField[], pdfPath?: string | null): void {
  saveApplication(tenderId, JSON.stringify(fields), pdfPath);
}
