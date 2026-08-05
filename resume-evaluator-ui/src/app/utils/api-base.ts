import { environment } from '../../environments/environment';

declare global {
  interface Window {
    __env?: { API_URL?: string };
  }
}

/**
 * Resolve API host for HttpClient and media/download URLs.
 * Prefer runtime window.__env.API_URL (SSR/deploy injection) over compile-time env.
 */
export function resolveApiBase(): string {
  let fromRuntime = '';
  if (typeof window !== 'undefined' && window.__env?.API_URL) {
    const raw = String(window.__env.API_URL).trim();
    if (raw && raw !== '__API_URL__') {
      fromRuntime = raw;
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
