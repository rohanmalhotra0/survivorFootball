import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { createHostedApp } from './app.js';
import { getHostedSchedule } from './schedule.js';

export function createHostedEntry() {
  const app = express();
  app.disable('x-powered-by');
  app.get('/api/cron/sync', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const secret = process.env.CRON_SECRET;
    const received = req.get('authorization') || '';
    const expected = `Bearer ${secret || ''}`;
    if (!secret || Buffer.byteLength(received) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return res.status(401).json({ error: 'Unauthorized.' });
    try {
      const snapshot = await getHostedSchedule({ force: true, requirePersistence: true });
      res.json({ ok: true, season: snapshot.season, games: snapshot.games.length, updatedAt: snapshot.updatedAt, stale: snapshot.stale });
    } catch { res.status(503).json({ error: 'Schedule refresh failed. Check provider availability and Supabase configuration.' }); }
  });
  app.use(createHostedApp({ getSchedule: () => getHostedSchedule() }));
  return app;
}
