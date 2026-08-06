import { environment } from '../../environments/environment';

declare global {
  interface Window {
    __env?: { API_URL?: string; API_KEY?: string };
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

/**
 * Resolve API key without committing secrets.
 * Order: window.__env.API_KEY (SSR/runtime) → environment.apiKey.
 */
export function resolveApiKey(): string {
  if (typeof window !== 'undefined' && window.__env?.API_KEY) {
    const raw = String(window.__env.API_KEY).trim();
    if (raw && raw !== '__API_KEY__') {
      return raw;
    }
  }
  return String((environment as { apiKey?: string }).apiKey || '').trim();
}

/** Append api_key query for anchor/window.open downloads when a key is configured. */
export function withApiKeyQuery(url: string): string {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    return url;
  }
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api_key=${encodeURIComponent(apiKey)}`;
}
