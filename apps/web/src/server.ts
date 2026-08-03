import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

// Cloud Run health checks. Registered before the catch-all so a probe never
// pays the cost of a render.
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

// Hashed build output is immutable, so it can be cached indefinitely.
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => {
      if (!response) {
        return next();
      }
      // Let the CDN serve rendered HTML while revalidating in the background,
      // so a publish propagates quickly without every visitor paying for SSR.
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
      return writeResponseToNodeResponse(response, res);
    })
    .catch(next);
});

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  // Cloud Run injects PORT and routes traffic to 0.0.0.0.
  const port = Number(process.env['PORT'] ?? 4000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Public site listening on :${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
