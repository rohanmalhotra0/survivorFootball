import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSchedule, parseScheduleCsv, SCHEDULE_URL } from '../data-provider.js';
import type { ScheduleSnapshot } from '../../shared/types.js';

const FRESH_MS = 30 * 60 * 1000;
export interface HostedScheduleOptions {
  force?: boolean;
  requirePersistence?: boolean;
  client?: Pick<SupabaseClient, 'rpc'>;
  fetchFeed?: typeof fetch;
}

export function scheduleServiceClient(): SupabaseClient {
  const endpoint = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!endpoint || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in server environment settings.');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SUPABASE_URL must be the HTTPS project origin.');
  }
  return createClient(url.origin, key, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal || AbortSignal.timeout(8000) }) } });
}

function snapshot(value: unknown): ScheduleSnapshot {
  if (!value || typeof value !== 'object') throw new Error('The hosted schedule is unavailable.');
  const data = value as ScheduleSnapshot;
  if (!Array.isArray(data.games) || !Number.isInteger(data.season) || !Number.isInteger(data.currentWeek) || typeof data.source !== 'string') throw new Error('The hosted schedule has an invalid format.');
  return data;
}

/** Durable PostgreSQL cache + refresh lease; no local writes, intervals, or cron precision needed. */
export async function getHostedSchedule(options: HostedScheduleOptions = {}): Promise<ScheduleSnapshot> {
  let client: Pick<SupabaseClient, 'rpc'>;
  try { client = options.client || scheduleServiceClient(); }
  catch (error) {
    if (options.requirePersistence) throw error;
    return { ...getSchedule(), stale: true };
  }
  let cached: ScheduleSnapshot;
  try {
    const read = await client.rpc('survivor_schedule');
    if (read.error) throw new Error('Apply the Supabase migration before loading the hosted schedule.');
    cached = snapshot(read.data);
  } catch (error) {
    if (options.requirePersistence) throw error;
    return { ...getSchedule(), stale: true };
  }
  const age = cached.updatedAt ? Date.now() - Date.parse(cached.updatedAt) : Infinity;
  if (!options.force && cached.games.length && !cached.stale && age < FRESH_MS) return cached;
  let acquired = false;
  try {
    const lease = await client.rpc('survivor_claim_schedule_refresh', { p_force: !!options.force });
    if (lease.error) throw new Error('The schedule refresh migration is missing or unavailable.');
    acquired = !!lease.data?.acquired;
  } catch {
    if (options.requirePersistence) throw new Error('The schedule refresh migration is missing or unavailable.');
    return cached.games.length ? { ...cached, stale: true } : { ...getSchedule(), stale: true };
  }
  if (!acquired) {
    if (options.requirePersistence && (!cached.games.length || cached.stale || age >= FRESH_MS || !Number.isFinite(age))) throw new Error('Another refresh is in progress. Retry shortly.');
    return cached.games.length ? cached : { ...getSchedule(), stale: true };
  }
  try {
    const response = await (options.fetchFeed || fetch)(SCHEDULE_URL, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('The NFL data provider is unavailable.');
    const csv = await response.text();
    if (csv.length > 20_000_000) throw new Error('The schedule feed exceeded its size limit.');
    const retainedSeasons = [...new Set(cached.games.map(game => game.season))];
    const next = parseScheduleCsv(csv, new Date(), retainedSeasons);
    const write = await client.rpc('survivor_sync_schedule', { p_snapshot: next });
    if (write.error) throw new Error('The schedule could not be saved to Supabase.');
    const saved = await client.rpc('survivor_schedule');
    if (saved.error) throw new Error('The saved schedule could not be read.');
    return snapshot(saved.data);
  } catch (error) {
    await client.rpc('survivor_fail_schedule_refresh').then(() => undefined, () => undefined);
    if (options.requirePersistence) throw error;
    return cached.games.length ? { ...cached, stale: true } : { ...getSchedule(), stale: true };
  }
}
