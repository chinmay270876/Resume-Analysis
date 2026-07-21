import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';

const browserDistFolder = join(import.meta.dirname, '../browser');
const API_URL = process.env['API_URL'] || 'https://resume-analysis-api-so26.onrender.com';

const app = express();
const angularApp = new AngularNodeAppEngine();

/**
 * Example Express Rest API endpoints can be defined here.
 * Uncomment and define endpoints as necessary.
 *
 * Example:
 * ```ts
 * app.get('/api/{*splat}', (req, res) => {
 *   // Handle API request
 * });
 * ```
 */

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Inject runtime API_URL into HTML responses for Angular Universal SSR.
 */
app.use((req, res, next) => {
  const chunks: Buffer[] = [];
  const originalWrite = res.write;
  const originalEnd = res.end;

  res.write = function (this: express.Response, chunk: any, encoding: any, callback: any) {
    if (chunk != null) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, encoding));
      }
    }
    return true;
  } as any;

  res.end = function (this: express.Response, chunk: any, encoding: any, callback: any) {
    if (chunk != null) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, encoding));
      }
    }

    const body = Buffer.concat(chunks).toString('utf-8');
    const replaced = body.replace(/__API_URL__/g, API_URL);

    return originalEnd.call(this, replaced, encoding, callback);
  } as any;

  next();
});

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
