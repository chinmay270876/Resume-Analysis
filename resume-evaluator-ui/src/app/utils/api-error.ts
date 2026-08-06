import { HttpErrorResponse } from '@angular/common/http';

/**
 * Extract a user-facing message from an Angular HttpErrorResponse.
 * Handles JSON API errors, HTML 404 pages (wrong host / gunicorn), and network failures.
 */
export function extractApiErrorMessage(
  error: unknown,
  fallback = 'Request failed. Please try again.'
): string {
  if (!(error instanceof HttpErrorResponse)) {
    if (error && typeof error === 'object' && 'message' in error) {
      const msg = (error as { message?: unknown }).message;
      if (typeof msg === 'string' && msg.trim()) {
        return msg;
      }
    }
    return fallback;
  }

  if (error.status === 0) {
    return 'Cannot reach the API server. Check your network connection and that the backend is online.';
  }

  const body = error.error;

  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const obj = body as { error?: unknown; message?: unknown };
    if (typeof obj.error === 'string' && obj.error.trim()) {
      return obj.error;
    }
    if (typeof obj.message === 'string' && obj.message.trim()) {
      return obj.message;
    }
  }

  if (typeof body === 'string' && body.trim()) {
    const trimmed = body.trim();
    if (/<!doctype|<html|not found/i.test(trimmed)) {
      if (error.status === 404) {
        return 'API endpoint not found (404). The frontend is likely pointing at the wrong backend URL or the API service is misconfigured.';
      }
      return `API returned an unexpected HTML response (HTTP ${error.status}). Check that the backend URL is correct.`;
    }
    // Avoid dumping long HTML/text into the UI
    if (trimmed.length <= 300 && !trimmed.includes('<')) {
      return trimmed;
    }
  }

  if (error.status === 404) {
    return 'API endpoint not found (404). Verify the production API URL and that the route exists.';
  }

  if (error.status === 401) {
    return 'Unauthorized. Check that the frontend API key matches the backend API_KEY.';
  }

  if (error.status === 413) {
    return 'Uploaded file is too large.';
  }

  if (error.status >= 500) {
    return `Server error (HTTP ${error.status}). Please try again shortly.`;
  }

  if (typeof error.message === 'string' && error.message && error.message !== 'Http failure response for (unknown url): 0 Unknown Error') {
    // Angular's generic message often includes the URL; keep it short when useful
    if (!/Http failure response/i.test(error.message)) {
      return error.message;
    }
  }

  return fallback;
}
