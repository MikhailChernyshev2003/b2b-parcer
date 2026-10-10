import { config } from "../config.js";
import { fetcher } from "../http/fetcher.js";
import type { TenderCard, TenderFile } from "../types.js";
import { clean } from "../util.js";

/**
 * Cards of the new layout (/app/market-next/.../tender-N/) are a client-side
 * app with no data in the HTML; their data comes from this openapi method.
 * It works for guests, but only for market-next trades (classic ones answer
 * AppInvalidArgumentException). With a Bearer token (see fetcher) it also
 * returns the documentation files and the additional description.
 */
const GET_TRADE_PATH = "/market/openapi/v2/trade/get_trade/";

export function isMarketNextUrl(url: string): boolean {
  return url.includes("/app/market-next/");
}

interface Hint {
  hint?: { title?: string };
}
interface Value<T> {
  value?: T;
}

interface GetTradeResponse {
  status?: { code?: number; message?: string };
  trade?: {
    id: number;
    type?: { name?: Hint };
    status?: { name?: Hint };
    date_published?: string;
    date_modified?: string;
    firm?: { short_name?: string; full_name?: string; inn?: string };
    fields_values?: {
      subject?: Value<string>;
      payment_terms?: Value<string>;
      delivery_terms?: Value<string>;
      delivery_address?: { address?: { address_string?: string } }[];
      offers_stage_date_end?: Value<string>;
      currency?: { currency?: { symbol?: string } };
      main_price_type?: { option?: { name?: Hint } };
      additional_description?: Value<string>;
      [k: string]: unknown;
    };
    settings_values?: {
      participants_count?: Value<number>;
      offers_count?: Value<number>;
      main_stage_date_end?: Value<string>;
      has_document_by_registered_user?: Value<boolean>;
      [k: string]: unknown;
    };
  };
}

interface ApiFile {
  id?: number;
  title?: string;
  uri?: string;
}

/**
 * All downloadable files in the trade's field values. Documentation lives in
 * different fields depending on the trade ("doc" — public, "documentation" —
 * for registered users, application templates in offers_template_fields), all
 * as file_group.files[] with a /download.html uri, so collect them wherever
 * they are. Contact data is skipped.
 */
function collectFiles(fieldValues: object): TenderFile[] {
  const out = new Map<string, TenderFile>();
  const walk = (node: unknown, key: string) => {
    if (!node || typeof node !== "object" || key === "contact") return;
    const files = (node as { file_group?: { files?: ApiFile[] } }).file_group?.files;
    for (const f of files ?? []) {
      if (!f.uri) continue;
      const url = f.uri.startsWith("http") ? f.uri : `${config.baseUrl}${f.uri}`;
      out.set(url, { name: clean(f.title) || `file-${f.id}`, url, localPath: null });
    }
    for (const [k, v] of Object.entries(node)) walk(v, k);
  };
  walk(fieldValues, "");
  return [...out.values()];
}

/** Fetch a market-next tender card via get_trade and map it to TenderCard. */
export async function fetchTradeCard(id: string, url: string): Promise<TenderCard> {
  const res = await fetcher.postJson<GetTradeResponse>(`${config.baseUrl}${GET_TRADE_PATH}`, {
    trade_id: Number(id),
  });
  const t = res.trade;
  if (res.status?.code !== 1 || !t) {
    throw new Error(`get_trade(${id}) не вернул данные: ${res.status?.message ?? "нет поля trade"}`);
  }
  const fv = t.fields_values ?? {};
  const sv = t.settings_values ?? {};

  const infoRows: Record<string, string> = {};
  const put = (label: string, v: unknown) => {
    const s = clean(v == null ? null : String(v));
    if (s) infoRows[label] = s;
  };
  put("Статус", t.status?.name?.hint?.title);
  put("Адрес поставки", (fv.delivery_address ?? []).map((a) => a.address?.address_string).filter(Boolean).join("; "));
  put("Тип цены", fv.main_price_type?.option?.name?.hint?.title);
  put("ИНН организатора", t.firm?.inn);
  put("Организатор (полное наименование)", t.firm?.full_name);
  put("Предложений подано", sv.offers_count?.value);
  put("Дополнительное описание", fv.additional_description?.value);

  const files = collectFiles(fv);
  const docsForRegistered = Boolean(sv.has_document_by_registered_user?.value);

  const participants = sv.participants_count?.value;

  return {
    id,
    url,
    procedureType: clean(t.type?.name?.hint?.title),
    title: clean(fv.subject?.value),
    organizerName: clean(t.firm?.short_name),
    customerName: null,
    // Region and category are not in get_trade; the search list provides them.
    region: null,
    category: null,
    publishedAt: t.date_published ?? null,
    endAt: fv.offers_stage_date_end?.value ?? sv.main_stage_date_end?.value ?? null,
    lastEditedAt: t.date_modified ?? null,
    price: null,
    currency: clean(fv.currency?.currency?.symbol),
    participants: participants != null ? String(participants) : null,
    paymentTerms: clean(fv.payment_terms?.value),
    deliveryTerms: clean(fv.delivery_terms?.value),
    // Documentation is listed only for an authenticated request.
    requiresAuth: docsForRegistered && !files.length,
    files,
    infoRows,
    fetchedAt: new Date().toISOString(),
  };
}
