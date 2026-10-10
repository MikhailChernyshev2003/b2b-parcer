/** Listing status bucket of the market search (Актуально / В архиве / Все). */
export type MarketStatus = "actual" | "archive" | "all";

/** Trade direction: закупки (buy), продажи (sell) or both (two requests). */
export type TradeType = "all" | "buy" | "sell";

/**
 * Parameters for a single market search request.
 * Filters other than keyword/status/trade are honoured by the site only for
 * an authenticated session; for guests they are silently ignored.
 */
export interface SearchQuery {
  /** Keyword query (supports b2b search syntax: трубы !стальные, "электрод", смаз*). */
  keyword?: string;
  status?: MarketStatus;
  trade?: TradeType;
  /** Inclusive publication date window (dd.mm.yyyy). Auth only. */
  dateFrom?: string;
  dateTo?: string;
  organizerId?: string;
  priceFrom?: number;
  priceTo?: number;
}

/** A row from the market search API. */
export interface TenderListItem {
  /** Procedure id, e.g. "4492697". */
  id: string;
  /** Combined trade-stage id (id + type suffix) from data-id/tsid, e.g. "4492697004". */
  tsid: string | null;
  /** Procedure type label, e.g. "Запрос предложений", "Объявление о продаже". */
  procedureType: string | null;
  category: string | null;
  title: string;
  description: string | null;
  url: string;
  organizerName: string | null;
  organizerUrl: string | null;
  region: string | null;
  price: string | null;
  publishedAt: string | null;
  actualUntil: string | null;
  status: MarketStatus;
  scrapedAt: string;
}

/** A documentation file reference found on a tender card. */
export interface TenderFile {
  name: string;
  url: string;
  /** Local relative path once downloaded (null if not downloaded / not accessible). */
  localPath: string | null;
}

/** Detailed data parsed from a tender card page. */
export interface TenderCard {
  id: string;
  url: string;
  procedureType: string | null;
  title: string | null;
  organizerName: string | null;
  customerName: string | null;
  region: string | null;
  category: string | null;
  publishedAt: string | null;
  endAt: string | null;
  lastEditedAt: string | null;
  price: string | null;
  currency: string | null;
  participants: string | null;
  paymentTerms: string | null;
  deliveryTerms: string | null;
  /** Whether full details require authentication (guest-limited page). */
  requiresAuth: boolean;
  files: TenderFile[];
  /** Raw extracted info rows label->value for anything not explicitly mapped. */
  infoRows: Record<string, string>;
  fetchedAt: string;
}
