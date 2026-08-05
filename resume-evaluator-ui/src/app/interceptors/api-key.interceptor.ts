import { HttpInterceptorFn } from '@angular/common/http';
import { environment } from '../../environments/environment';

/**
 * When environment.apiKey is set, attach X-API-Key to API requests.
 * No-op when unset so local/dev keeps working without a key.
 */
export const apiKeyInterceptor: HttpInterceptorFn = (req, next) => {
  const apiKey = (environment as { apiKey?: string }).apiKey;
  if (!apiKey) {
    return next(req);
  }

  return next(
    req.clone({
      setHeaders: {
        'X-API-Key': apiKey,
      },
    })
  );
};
