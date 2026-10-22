import express from 'express';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { getSchedule, syncSchedule } from './data-provider.js';
import { createDemoDashboard } from './demo.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const hosted = process.env.APP_BACKEND === 'supabase' || process.env.VERCEL === '1';
const application = hosted
  ? { app: (await import('./hosted/entry.js')).createHostedEntry(), close: () => {} }
  : (await import('./app.js')).createApp({
    dbPath: process.env.DATABASE_PATH || resolve(root, 'data/survivor.sqlite'),
    getSchedule,
    getDemoDashboard: createDemoDashboard,
  });
const app = application.app;
const server = createHttpServer(app);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.supabase.co https://a.espncdn.com https://static.www.nfl.com; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  }
  next();
});
let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(resolve(root, 'dist'), { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(root, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  vite = await createServer({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}
server.once('error', error => {
  console.error(`Unable to start Survivor Club on port ${port}: ${error.message}`);
  void Promise.resolve(vite?.close()).finally(() => { application.close(); process.exit(1); });
});
server.listen(port, '0.0.0.0', () => {
  console.log(`Survivor Club listening on port ${port} (${process.env.NODE_ENV === 'production' ? 'production' : 'development'}, ${hosted ? 'Supabase' : 'local SQLite'}).`);
});
// Startup remains usable with its last verified snapshot during provider outages.
if (!hosted) void syncSchedule();
const refresh = hosted ? undefined : setInterval(() => { void syncSchedule(); }, 30 * 60 * 1000);
refresh?.unref();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(refresh);
  await vite?.close();
  server.close(() => { application.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
