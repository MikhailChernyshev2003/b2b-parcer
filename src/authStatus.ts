import { fetcher } from "./http/fetcher.js";
import { logger } from "./logger.js";
import { hasAuth } from "./settings.js";
import { hasBrowserProfile, refreshSessionFromProfile } from "./auth/browserLogin.js";

/**
 * Result of the last real check of the configured cookie against the site.
 * "Cookie is set" is not the same as "logged in": cookies expire, and the new
 * search app needs its own session (see fetcher.checkAuth).
 */
export interface AuthStatus {
  cookieSet: boolean;
  /** null = not checked yet / check in progress. */
  checkedAt: string | null;
  /** Classic pages (cards, documentation) see a logged-in user. */
  authenticated: boolean | null;
  userId: string | null;
  /** The market search API sees a logged-in user (paging, date filters). */
  searchAuthenticated: boolean | null;
  error: string | null;
}

let status: AuthStatus = {
  cookieSet: false,
  checkedAt: null,
  authenticated: null,
  userId: null,
  searchAuthenticated: null,
  error: null,
};

export function getAuthStatus(): AuthStatus {
  return { ...status, cookieSet: hasAuth() };
}

/** Check the cookie against the site and remember the result. */
export async function refreshAuthStatus(): Promise<AuthStatus> {
  if (!hasAuth()) {
    status = { cookieSet: false, checkedAt: new Date().toISOString(), authenticated: false, userId: null, searchAuthenticated: false, error: null };
    return status;
  }
  try {
    const r = await fetcher.checkAuth();
    status = { cookieSet: true, checkedAt: new Date().toISOString(), ...r, error: null };
    if (!r.authenticated) logger.warn("Cookie B2B-Center задана, но сайт её не принимает — обновите её во вкладке «Настройки».");
  } catch (err) {
    status = { ...status, cookieSet: true, checkedAt: new Date().toISOString(), error: (err as Error).message };
    logger.warn(`Проверка авторизации не удалась: ${(err as Error).message}`);
  }
  return status;
}

/**
 * Check the session and, if it is gone, try to restore it silently from the
 * saved browser profile («Запомнить меня»). Used before scheduler cycles.
 */
export async function ensureSession(): Promise<AuthStatus> {
  let s = await refreshAuthStatus();
  if (!s.error && !s.authenticated && hasBrowserProfile()) {
    const userId = await refreshSessionFromProfile().catch((err) => {
      logger.warn(`Фоновое восстановление входа не удалось: ${(err as Error).message}`);
      return null;
    });
    if (userId) s = await refreshAuthStatus();
    else logger.warn("Сессия B2B-Center истекла — нажмите «Войти через браузер» во вкладке «Настройки».");
  }
  return s;
}

/** One-line human summary for logs and CLI. */
export function describeAuth(s: AuthStatus): string {
  if (!s.cookieSet) return "гость (cookie не задана)";
  if (s.error) return `не удалось проверить (${s.error})`;
  if (s.authenticated == null) return "cookie задана, не проверена";
  if (!s.authenticated) return "cookie недействительна — работа как гость";
  return s.searchAuthenticated
    ? `авторизован (user_id ${s.userId})`
    : `авторизован на классических страницах (user_id ${s.userId}); поиск работает как гость`;
}
