/** Listing status bucket on /market/ (Актуально / В архиве / Все). */
export type MarketStatus = "actual" | "archive" | "all";

/** Trade direction filter. */
export type TradeType = "all" | "buy" | "sell";

/** "Опубликовано" | "Актуально" | "Изменено" date filter mode. */
export type DateMode = "published" | "actual" | "changed";

/** Parameters for a single /market/ search request. */
export interface SearchQuery {
  /** Keyword query (supports b2b search syntax: трубы !стальные, "электрод", смаз*). */
  keyword?: string;
  status?: MarketStatus;
  trade?: TradeType;
  dateMode?: DateMode;
  /** Inclusive date window (dd.mm.yyyy), used together with dateMode. */
  dateFrom?: string;
  dateTo?: string;
  region?: string;
  customerId?: string;
  organizerId?: string;
  priceFrom?: number;
  priceTo?: number;
  onlySmp?: boolean;
  only223fz?: boolean;
}

/** A row parsed from the /market/ search results table. */
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
