import express, { type Request, type Response, type NextFunction } from 'express';
import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDemoDashboard } from '../demo.js';
import { createSupabaseAdminClient, createSupabaseRequestClient, publicUser } from './auth.js';
import { HostedConfigurationError, loadHostedConfig, type HostedConfig } from './config.js';
import type { ScheduleSnapshot, User } from '../../shared/types.js';

export interface HostedAppOptions {
  getSchedule: () => Promise<ScheduleSnapshot>;
  config?: HostedConfig;
  createRequestClient?: (req: Request, res: Response, config: HostedConfig) => SupabaseClient;
  enforceRateLimit?: (kind: string, keyHash: string) => Promise<{ allowed: boolean; retryAfter: number }>;
}

function fail(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
function stringValue(body: unknown, name: string, minimum: number, maximum: number): string {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
  if (typeof value !== 'string' || value.trim().length < minimum || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    throw fail(`${name} must be between ${minimum} and ${maximum} characters.`);
  }
  return value.trim();
}
function emailValue(body: unknown): string {
  const email = stringValue(body, 'email', 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Enter a valid email address.');
  return email;
}
function passwordValue(body: unknown): string {
  const password = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).password : undefined;
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw fail('Use a password between 12 and 128 characters.');
  return password;
}
function weekValue(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'string' && /^\d{1,2}$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 18) throw fail('Week must be between 1 and 18.');
  return number;
}
function leagueId(req: Request): string {
  const value = String(req.params.id);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw fail('League not found.', 404);
  return value;
}

export function createHostedApp(options: HostedAppOptions) {
  let config: HostedConfig | undefined;
  let configurationError: string | undefined;
  try { config = options.config || loadHostedConfig(); }
  catch (error) { configurationError = error instanceof HostedConfigurationError ? error.message : 'Hosted configuration is unavailable.'; }
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  app.get('/api/health', (_req, res) => {
    if (!config) return res.status(503).json({ status: 'unconfigured', authProvider: 'supabase', error: configurationError });
    res.json({ status: 'ok', authProvider: 'supabase', passwordRecovery: true });
  });
  app.get('/api/demo', async (req, res) => {
    const snapshot = await options.getSchedule();
    res.json(createDemoDashboard(snapshot, weekValue(req.query.week) ?? snapshot.currentWeek));
  });
  app.use('/api', (_req, _res, next) => {
    if (!config) return next(fail(configurationError || 'Hosted configuration is unavailable.', 503));
    next();
  });
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!/^application\/json(?:\s*;|$)/i.test(req.get('content-type') || '')) return next(fail('Use application/json for requests.', 415));
    if (req.get('sec-fetch-site') === 'cross-site') return next(fail('Cross-site request denied.', 403));
    const origin = req.get('origin');
    if (origin) {
      try { if (new URL(origin).origin !== config!.appOrigin) return next(fail('Cross-site request denied.', 403)); }
      catch { return next(fail('Invalid request origin.', 403)); }
    }
    next();
  });

  const clients = new WeakMap<Request, SupabaseClient>();
  function client(req: Request, res: Response) {
    let value = clients.get(req);
    if (!value) { value = (options.createRequestClient || createSupabaseRequestClient)(req, res, config!); clients.set(req, value); }
    return value;
  }
  async function userFor(req: Request, res: Response, required = true): Promise<User | null> {
    const { data, error } = await client(req, res).auth.getUser();
    if (error && error.status && error.status >= 500) throw fail('Sign-in service is temporarily unavailable. Please retry.', 503);
    if (error || !data.user) {
      if (required) throw fail('Sign in to continue.', 401);
      return null;
    }
    return publicUser(data.user);
  }
  async function rpc(req: Request, res: Response, name: string, args?: Record<string, unknown>) {
    const { data, error } = await client(req, res).rpc(name, args);
    if (error) {
      const mapped: Record<string, [number, string]> = {
        PT400: [400, 'The league request is invalid.'],
        PT401: [401, 'Sign in to continue.'],
        PT403: [403, 'You do not have access to this action.'],
        PT404: [404, 'League not found.'],
        PT409: [409, 'This action is no longer available. Refresh your league and try again.'],
        PT429: [429, 'Too many attempts. Please try again later.'],
        PT503: [503, 'League service is temporarily unavailable. Please retry.'],
        PGRST301: [401, 'Sign in to continue.'],
        PGRST302: [401, 'Sign in to continue.'],
        PGRST303: [401, 'Sign in to continue.'],
        '23505': [409, 'This selection or membership already exists. Refresh your league and try again.'],
      };
      if (mapped[error.code]) {
        const [status, message] = mapped[error.code];
        if (status === 429) res.setHeader('Retry-After', '60');
        throw fail(message, status);
      }
      if (error.code === '42501') throw fail('You do not have access to this action.', 403);
      throw fail('League service is temporarily unavailable. Please retry.', 503);
    }
    if (data && typeof data === 'object' && 'error' in data && data.error) {
      const failure = data.error as { message?: unknown; status?: unknown };
      const status = typeof failure.status === 'number' && [400, 401, 403, 404, 409, 429, 503].includes(failure.status) ? failure.status : 400;
      throw fail(typeof failure.message === 'string' ? failure.message : 'The league action could not be completed.', status);
    }
    return data;
  }
  async function rateLimit(req: Request, res: Response, kind: string) {
    // Vercel owns this forwarding header at its ingress. Other hosts use socket IP.
    const ip = process.env.VERCEL === '1' ? (req.get('x-forwarded-for') || req.socket.remoteAddress || 'unknown').split(',')[0].trim() : req.socket.remoteAddress || 'unknown';
    const hash = createHmac('sha256', config!.serviceRoleKey || config!.publishableKey).update(`${kind}:${ip}`).digest('hex');
    let result: { allowed: boolean; retryAfter: number };
    try {
      if (options.enforceRateLimit) result = await options.enforceRateLimit(kind, hash);
      else {
        const { data, error } = await createSupabaseAdminClient(config!).rpc('survivor_rate_limit', { p_kind: kind, p_key_hash: hash });
        if (error || !data || typeof data.allowed !== 'boolean') throw new Error('Rate limiter unavailable.');
        result = data;
      }
    } catch { throw fail('Sign-in service is temporarily unavailable. Please retry.', 503); }
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfter || 60))));
      throw fail('Too many attempts. Please try again later.', 429);
    }
  }

  app.get('/api/auth/me', async (req, res) => { res.json({ user: await userFor(req, res, false) }); });
  app.post('/api/auth/register', async (req, res) => {
    const name = stringValue(req.body, 'name', 2, 40);
    const email = emailValue(req.body);
    const password = passwordValue(req.body);
    await rateLimit(req, res, 'auth-register');
    const { data, error } = await client(req, res).auth.signUp({ email, password, options: { data: { name }, emailRedirectTo: `${config!.appOrigin}/api/auth/callback` } });
    if (error && error.code !== 'user_already_exists') {
      if (error.status === 429) throw fail('Too many attempts. Please try again later.', 429);
      throw fail('Account creation could not be completed. Please retry.', error.status && error.status >= 500 ? 503 : 400);
    }
    if (!error && data.session && data.user) return res.status(201).json({ user: publicUser(data.user), confirmationRequired: false });
    res.status(201).json({ user: null, confirmationRequired: true, message: 'Check your email to confirm your account, then return to sign in.' });
  });
  app.post('/api/auth/login', async (req, res) => {
    const email = emailValue(req.body);
    const password = passwordValue(req.body);
    await rateLimit(req, res, 'auth-login');
    const { data, error } = await client(req, res).auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      if (error?.status === 429) throw fail('Too many attempts. Please try again later.', 429);
      if (error?.status && error.status >= 500) throw fail('Sign-in service is temporarily unavailable. Please retry.', 503);
      if (error?.code === 'email_not_confirmed') throw fail('Confirm your email before signing in. Check your inbox for the confirmation link.', 401);
      throw fail('Email or password is incorrect.', 401);
    }
    res.json({ user: publicUser(data.user) });
  });
  app.post('/api/auth/logout', async (req, res) => {
    const { error } = await client(req, res).auth.signOut({ scope: 'local' });
    if (error && error.status && error.status >= 500) throw fail('Sign-out service is temporarily unavailable. Please retry.', 503);
    res.json({ ok: true });
  });
  app.post('/api/auth/forgot-password', async (req, res) => {
    const email = emailValue(req.body);
    await rateLimit(req, res, 'auth-reset');
    // The response does not disclose whether this address is registered.
    const { error } = await client(req, res).auth.resetPasswordForEmail(email, { redirectTo: `${config!.appOrigin}/api/auth/callback?next=recovery` });
    if (error?.status && error.status >= 500) throw fail('Password recovery is temporarily unavailable. Please retry.', 503);
    res.json({ ok: true, message: 'If an account exists for that email, a password-reset link will be sent.' });
  });
  app.get('/api/auth/callback', async (req, res) => {
    try {
      await rateLimit(req, res, 'auth-confirm');
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code || code.length > 4096) return res.redirect(303, '/?auth=error');
      const { error } = await client(req, res).auth.exchangeCodeForSession(code);
      if (error) return res.redirect(303, '/?auth=error');
      return res.redirect(303, req.query.next === 'recovery' ? '/?auth=recovery' : '/?auth=confirmed');
    } catch { return res.redirect(303, '/?auth=error'); }
  });
  app.post('/api/auth/reset-password', async (req, res) => {
    await userFor(req, res);
    const password = passwordValue(req.body);
    await rateLimit(req, res, 'auth-reset');
    const { error } = await client(req, res).auth.updateUser({ password });
    if (error) throw fail('Password could not be updated. Use a new password or request another reset link.', error.status && error.status >= 500 ? 503 : 400);
    await client(req, res).auth.signOut({ scope: 'others' });
    res.json({ ok: true });
  });

  app.get('/api/leagues', async (req, res) => { await userFor(req, res); res.json(await rpc(req, res, 'survivor_list_leagues')); });
  app.post('/api/leagues', async (req, res) => {
    await userFor(req, res);
    const name = stringValue(req.body, 'name', 3, 60);
    await options.getSchedule();
    res.status(201).json(await rpc(req, res, 'survivor_create_league', { p_name: name }));
  });
  app.post('/api/leagues/join', async (req, res) => {
    await userFor(req, res);
    const inviteCode = stringValue(req.body, 'inviteCode', 6, 32).toUpperCase();
    res.json(await rpc(req, res, 'survivor_join_league', { p_invite_code: inviteCode }));
  });
  app.get('/api/leagues/:id', async (req, res) => {
    await userFor(req, res);
    const id = leagueId(req);
    const week = weekValue(req.query.week);
    await options.getSchedule();
    res.json(await rpc(req, res, 'survivor_dashboard', { p_league_id: id, p_week: week }));
  });
  app.post('/api/leagues/:id/picks', async (req, res) => {
    await userFor(req, res);
    const id = leagueId(req);
    const week = weekValue(req.body?.week);
    const teamId = stringValue(req.body, 'teamId', 1, 10);
    await options.getSchedule();
    res.json(await rpc(req, res, 'survivor_submit_pick', { p_league_id: id, p_week: week, p_team_id: teamId }));
  });
  app.delete('/api/leagues/:id/picks', async (req, res) => {
    await userFor(req, res);
    const id = leagueId(req);
    const week = weekValue(req.query.week);
    res.json(await rpc(req, res, 'survivor_delete_pick', { p_league_id: id, p_week: week }));
  });
  app.use('/api', (_req, _res, next) => { next(fail('API route not found.', 404)); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const value = error as { status?: number; message?: string; type?: string };
    const status = typeof value?.status === 'number' && value.status >= 400 && value.status < 600 ? value.status : 500;
    res.status(status).json({ error: status === 500 ? 'The request could not be completed. Please retry.' : value.type === 'entity.parse.failed' ? 'Invalid JSON request.' : value.message || 'Request failed.' });
  });
  return app;
}
