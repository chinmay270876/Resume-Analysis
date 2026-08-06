import { environment } from '../../environments/environment';

declare global {
  interface Window {
    __env?: { API_URL?: string };
  }
}

const LOCAL_HOST_RE = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?/i;

/**
 * Single resolver for all API / download URLs.
 * Order: runtime window.__env.API_URL (SSR injection) → environment.apiUrl.
 * Production builds never accept a localhost runtime override.
 */
export function resolveApiBase(): string {
  let fromRuntime = '';
  if (typeof window !== 'undefined' && window.__env?.API_URL) {
    const raw = String(window.__env.API_URL).trim();
    if (raw && raw !== '__API_URL__') {
      const isLocal = LOCAL_HOST_RE.test(raw);
      if (!(environment.production && isLocal)) {
        fromRuntime = raw;
      }
    }
  }

  const base = (fromRuntime || environment.apiUrl || '').replace(/\/api\/?$/, '');
  return base.replace(/\/$/, '');
}

/** Append api_key query for anchor/window.open downloads when a key is configured. */
export function withApiKeyQuery(url: string): string {
  const apiKey = (environment as { apiKey?: string }).apiKey;
  if (!apiKey) {
    return url;
  }
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api_key=${encodeURIComponent(apiKey)}`;
}
