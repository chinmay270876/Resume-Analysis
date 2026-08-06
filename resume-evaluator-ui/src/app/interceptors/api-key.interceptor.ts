import { HttpInterceptorFn } from '@angular/common/http';
import { resolveApiKey } from '../utils/api-base';

/**
 * When an API key is configured (runtime or environment), attach X-API-Key.
 * No-op when unset so local/dev and open backends keep working.
 */
export const apiKeyInterceptor: HttpInterceptorFn = (req, next) => {
  const apiKey = resolveApiKey();
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
