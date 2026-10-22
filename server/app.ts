import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase, type Database } from './database.js';
import { createSession, hashPassword, logout, readUser, verifyPassword, type AuthUser } from './auth.js';
import { isGameLocked, isRevealed, publicError, resolvePick, revealAtForWeek } from './domain.js';
import type { Dashboard, Game, League, Member, Pick, PickHistory, ScheduleSnapshot } from '../shared/types.js';

interface LeagueRow { id: string; name: string; invite_code: string; owner_id: string; season: number; start_week: number; created_at: string }
interface PickRow { id: string; league_id: string; user_id: string; week: number; team_id: string; game_id: string; created_at: string; updated_at: string }
interface LeagueResults {
  statuses: Map<string, { status: Member['status']; eliminatedWeek?: number }>;
  endedWeek?: number;
}
interface AppOptions {
  dbPath: string;
  now?: () => Date;
  getSchedule: () => ScheduleSnapshot | Promise<ScheduleSnapshot>;
  getDemoDashboard?: (snapshot: ScheduleSnapshot, week?: number) => Dashboard;
}

function bodyString(body: unknown, key: string, minimum: number, maximum: number): string {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  if (typeof value !== 'string' || value.trim().length < minimum || value.length > maximum) {
    throw publicError(`${key} must be between ${minimum} and ${maximum} characters.`);
  }
  return value.trim();
}

function emailAddress(body: unknown): string {
  const email = bodyString(body, 'email', 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw publicError('Enter a valid email address.');
  return email;
}

function passwordValue(body: unknown): string {
  const password = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).password : undefined;
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw publicError('Use a password between 12 and 128 characters.');
  }
  return password;
}

function weekValue(value: unknown, defaultWeek: number): number {
  if (value === undefined) return defaultWeek;
  const week = typeof value === 'string' && /^\d{1,2}$/.test(value) ? Number(value) : value;
  if (typeof week !== 'number' || !Number.isInteger(week) || week < 1 || week > 18) throw publicError('Week must be between 1 and 18.');
  return week;
}

export function createApp(options: AppOptions) {
  const db = openDatabase(options.dbPath);
  const now = options.now || (() => new Date());
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb', strict: true }));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // JSON-only writes make browser cross-site form attacks fail, including login CSRF.
    if (!/^application\/json(?:\s*;|$)/i.test(req.get('content-type') || '')) return next(publicError('Use application/json for requests.', 415));
    if (req.get('sec-fetch-site') === 'cross-site') return next(publicError('Cross-site request denied.', 403));
    const origin = req.get('origin');
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const expectedOrigin = process.env.APP_ORIGIN;
        if (expectedOrigin ? originUrl.origin !== new URL(expectedOrigin).origin : originUrl.host !== req.get('host')) {
          return next(publicError('Cross-site request denied.', 403));
        }
      } catch { return next(publicError('Invalid request origin.', 403)); }
    }
    next();
  });

  const attempts = new Map<string, { count: number; expires: number }>();
  function rateLimit(kind: string, limit: number, milliseconds: number) {
    return (req: Request, res: Response, next: NextFunction) => {
      const at = now().getTime();
      // The process does not trust spoofable forwarded IP headers.
      const key = `${kind}:${req.ip}`;
      let bucket = attempts.get(key);
      if (!bucket || at >= bucket.expires) bucket = { count: 0, expires: at + milliseconds };
      bucket.count++;
      attempts.set(key, bucket);
      if (attempts.size > 10000) for (const [id, value] of attempts) if (value.expires <= at) attempts.delete(id);
      if (bucket.count > limit) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.expires - at) / 1000))));
        return next(publicError('Too many attempts. Please try again later.', 429));
      }
      next();
    };
  }

  function requireUser(req: Request): AuthUser {
    const user = readUser(db, req, now());
    if (!user) throw publicError('Sign in to continue.', 401);
    return user;
  }

  function requireLeague(req: Request, user: AuthUser): LeagueRow {
    const row = db.prepare(`SELECT l.* FROM leagues l JOIN members m ON m.league_id=l.id
      WHERE l.id=? AND m.user_id=?`).get(String(req.params.id), user.id);
    if (!row) throw publicError('League not found.', 404);
    return row as unknown as LeagueRow;
  }

  function leagueView(league: LeagueRow, userId: string): League {
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM members WHERE league_id=?').get(league.id) as { count: number };
    return {
      id: league.id, name: league.name, inviteCode: league.invite_code, season: league.season,
      startWeek: league.start_week, memberCount: count, role: league.owner_id === userId ? 'commissioner' : 'member', createdAt: league.created_at,
    };
  }

  function leagueResults(league: LeagueRow, snapshot: ScheduleSnapshot, at: Date): LeagueResults {
    const members = db.prepare('SELECT user_id FROM members WHERE league_id=?').all(league.id) as { user_id: string }[];
    const picks = db.prepare('SELECT * FROM picks WHERE league_id=?').all(league.id) as unknown as PickRow[];
    const byEntryWeek = new Map(picks.map(pick => [`${pick.user_id}:${pick.week}`, pick]));
    const games = new Map(snapshot.games.filter(game => game.season === league.season).map(game => [game.id, game]));
    const statuses: LeagueResults['statuses'] = new Map(members.map(member => [member.user_id, { status: 'alive' }]));
    const unresolved = new Set<string>();
    for (let week = league.start_week; week <= 18 && isRevealed(league.season, week, at); week++) {
      const activeAtWeekStart = [...statuses].filter(([, state]) => state.status === 'alive').map(([userId]) => userId);
      const hasSchedule = snapshot.games.some(game => game.season === league.season && game.week === week);
      const thisWeek = new Map<string, string>();
      for (const [userId, state] of statuses) {
        if (state.status !== 'alive') continue;
        const pick = byEntryWeek.get(`${userId}:${week}`);
        const result = pick ? resolvePick(games.get(pick.game_id), pick.team_id) : hasSchedule ? 'missed' : 'pending';
        thisWeek.set(userId, result);
        if (result === 'pending') unresolved.add(userId);
        if (['loss', 'tie', 'missed'].includes(result)) statuses.set(userId, { status: 'eliminated', eliminatedWeek: week });
      }
      const alive = [...statuses].filter(([, state]) => state.status === 'alive').map(([userId]) => userId);
      const winnersReady = alive.length > 0 && alive.every(userId => !unresolved.has(userId) && ['win', 'void'].includes(thisWeek.get(userId) || ''));
      if (winnersReady && ((alive.length === 1 && members.length > 1) || week === 18)) {
        for (const userId of alive) statuses.set(userId, { status: 'winner' });
        return { statuses, endedWeek: week };
      }
      if (!alive.length) {
        // Yahoo's final-group rule: if all remaining entrants fall in the same
        // week, they share the win. Earlier unresolved games must settle first:
        // those results may establish a different final active group.
        const finalGroupSettled = activeAtWeekStart.every(userId => !unresolved.has(userId));
        if (members.length > 1 && finalGroupSettled) {
          for (const userId of activeAtWeekStart) statuses.set(userId, { status: 'winner' });
        }
        return { statuses, endedWeek: week };
      }
    }
    return { statuses };
  }

  function memberView(league: LeagueRow, member: { id: string; name: string }, viewerId: string, week: number, snapshot: ScheduleSnapshot, at: Date, results = leagueResults(league, snapshot, at)): Member {
    const rows = db.prepare('SELECT * FROM picks WHERE league_id=? AND user_id=? ORDER BY week').all(league.id, member.id) as unknown as PickRow[];
    const byWeek = new Map(rows.map(row => [row.week, row]));
    const gameById = new Map(snapshot.games.filter(game => game.season === league.season).map(game => [game.id, game]));
    const own = member.id === viewerId;
    const state = results.statuses.get(member.id) || { status: 'alive' as const };
    const eliminatedWeek = state.eliminatedWeek;
    const history: PickHistory[] = [];
    const latestLeagueWeek = league.season < snapshot.season ? 18 : snapshot.currentWeek;
    for (let historyWeek = league.start_week; historyWeek <= Math.min(results.endedWeek || 18, Math.max(week, latestLeagueWeek)); historyWeek++) {
      if (eliminatedWeek && historyWeek > eliminatedWeek) break;
      const row = byWeek.get(historyWeek);
      const publicWeek = isRevealed(league.season, historyWeek, at);
      const game = row ? gameById.get(row.game_id) : undefined;
      const hasSchedule = snapshot.games.some(g => g.season === league.season && g.week === historyWeek);
      const result = row ? resolvePick(game, row.team_id) : publicWeek && hasSchedule ? 'missed' : 'pending';
      // Neither early-game results nor the existence of a submitted pick leak through public metadata.
      if (!own && !publicWeek) {
        history.push({ week: historyWeek, status: 'hidden' });
      } else if (row) {
        history.push({ week: historyWeek, teamId: row.team_id, gameId: row.game_id, status: result });
      } else if (!eliminatedWeek || historyWeek <= eliminatedWeek) {
        history.push({ week: historyWeek, status: result });
      }
    }
    const selected = byWeek.get(week);
    const revealed = isRevealed(league.season, week, at);
    let pick: Pick | null = null;
    if (selected && (own || revealed)) {
      const game = gameById.get(selected.game_id);
      pick = { teamId: selected.team_id, gameId: selected.game_id, week, status: resolvePick(game, selected.team_id), locked: revealed || !game || isGameLocked(game, at) };
    }
    return {
      id: member.id, name: member.name, status: state.status,
      ...(eliminatedWeek ? { eliminatedWeek } : {}), pick,
      pickState: !own && !revealed ? 'hidden' : selected ? revealed ? 'revealed' : 'submitted' : 'missing', history,
    };
  }

  function dashboard(league: LeagueRow, userId: string, week: number, snapshot: ScheduleSnapshot, at: Date): Dashboard {
    const users = db.prepare(`SELECT u.id,u.name FROM members m JOIN users u ON u.id=m.user_id
      WHERE m.league_id=? ORDER BY m.joined_at,u.id`).all(league.id) as unknown as { id: string; name: string }[];
    const results = leagueResults(league, snapshot, at);
    const members = users.map(member => memberView(league, member, userId, week, snapshot, at, results));
    const games = snapshot.games.filter(game => game.season === league.season && game.week === week);
    const used = db.prepare('SELECT team_id FROM picks WHERE league_id=? AND user_id=? AND week<>? ORDER BY week').all(league.id, userId, week) as { team_id: string }[];
    return {
      league: leagueView(league, userId), season: league.season, week, revealAt: revealAtForWeek(league.season, week).toISOString(),
      picksRevealed: isRevealed(league.season, week, at), games, members,
      myPick: members.find(member => member.id === userId)?.pick || null, usedTeamIds: used.map(pick => pick.team_id),
      currentUserId: userId, currentWeek: league.season < snapshot.season ? 18 : snapshot.currentWeek, oddsUpdatedAt: snapshot.updatedAt,
      dataSource: snapshot.source, dataStale: snapshot.stale, demo: false,
    };
  }

  app.get('/api/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.get('/api/auth/me', (req, res) => { res.json({ user: readUser(db, req, now()) }); });
  app.post('/api/auth/register', rateLimit('register', 20, 3600000), async (req, res) => {
    const name = bodyString(req.body, 'name', 2, 40);
    const email = emailAddress(req.body);
    const password = passwordValue(req.body);
    const hashed = await hashPassword(password);
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw publicError('An account with this email already exists.', 409);
    const user: AuthUser = { id: randomUUID(), name, email };
    db.prepare('INSERT INTO users(id,name,email,password_hash,created_at) VALUES(?,?,?,?,?)').run(user.id, name, email, hashed, now().toISOString());
    createSession(db, req, res, user.id, now());
    res.status(201).json({ user });
  });
  app.post('/api/auth/login', rateLimit('login', 30, 900000), async (req, res) => {
    const email = emailAddress(req.body);
    const password = passwordValue(req.body);
    const row = db.prepare('SELECT id,name,email,password_hash FROM users WHERE email=?').get(email) as unknown as (AuthUser & { password_hash: string }) | undefined;
    if (!await verifyPassword(password, row?.password_hash) || !row) throw publicError('Email or password is incorrect.', 401);
    const user = { id: row.id, name: row.name, email: row.email };
    createSession(db, req, res, user.id, now());
    res.json({ user });
  });
  app.post('/api/auth/logout', (req, res) => { logout(db, req, res); res.json({ ok: true }); });

  app.get('/api/demo', async (req, res) => {
    if (!options.getDemoDashboard) throw publicError('Demo is not available.', 503);
    const snapshot = await options.getSchedule();
    res.json(options.getDemoDashboard(snapshot, weekValue(req.query.week, snapshot.currentWeek)));
  });
  app.get('/api/leagues', (req, res) => {
    const user = requireUser(req);
    const rows = db.prepare(`SELECT l.* FROM leagues l JOIN members m ON m.league_id=l.id
      WHERE m.user_id=? ORDER BY l.created_at DESC`).all(user.id) as unknown as LeagueRow[];
    res.json({ leagues: rows.map(row => leagueView(row, user.id)) });
  });
  app.post('/api/leagues', rateLimit('create-league', 30, 3600000), async (req, res) => {
    const user = requireUser(req);
    const name = bodyString(req.body, 'name', 3, 60);
    const snapshot = await options.getSchedule();
    const at = now();
    const defaultWeek = snapshot.currentWeek + (isRevealed(snapshot.season, snapshot.currentWeek, at) ? 1 : 0);
    if (defaultWeek > 18) throw publicError('The regular season has ended. New leagues open when next season’s schedule is available.');
    const season = req.body.season === undefined ? snapshot.season : req.body.season;
    const startWeek = weekValue(req.body.startWeek, defaultWeek);
    if (season !== snapshot.season || startWeek < defaultWeek || startWeek > Math.min(18, defaultWeek + 1)) throw publicError('Choose the next available regular-season week.');
    const row: LeagueRow = {
      id: randomUUID(), name, invite_code: randomBytes(6).toString('hex').toUpperCase(), owner_id: user.id,
      season, start_week: startWeek, created_at: at.toISOString(),
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO leagues(id,name,invite_code,owner_id,season,start_week,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(row.id, row.name, row.invite_code, row.owner_id, row.season, row.start_week, row.created_at);
      db.prepare('INSERT INTO members(league_id,user_id,joined_at) VALUES(?,?,?)').run(row.id, user.id, at.toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.status(201).json({ league: leagueView(row, user.id) });
  });
  app.post('/api/leagues/join', rateLimit('join-league', 30, 900000), (req, res) => {
    const user = requireUser(req);
    const inviteCode = bodyString(req.body, 'inviteCode', 6, 32).toUpperCase();
    const row = db.prepare('SELECT * FROM leagues WHERE invite_code=?').get(inviteCode) as unknown as LeagueRow | undefined;
    if (!row) throw publicError('Invite code was not found.', 404);
    if (db.prepare('SELECT 1 FROM members WHERE league_id=? AND user_id=?').get(row.id, user.id)) return res.json({ league: leagueView(row, user.id) });
    if (isRevealed(row.season, row.start_week, now())) throw publicError('This league has already started. Joining closes at its first Sunday reveal.', 409);
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM members WHERE league_id=?').get(row.id) as { count: number };
    if (count >= 100) throw publicError('This league has reached its 100-member limit.', 409);
    db.prepare('INSERT INTO members(league_id,user_id,joined_at) VALUES(?,?,?)').run(row.id, user.id, now().toISOString());
    res.json({ league: leagueView(row, user.id) });
  });
  app.get('/api/leagues/:id', async (req, res) => {
    const user = requireUser(req);
    const league = requireLeague(req, user);
    const snapshot = await options.getSchedule();
    const week = weekValue(req.query.week, league.season < snapshot.season ? 18 : Math.max(league.start_week, snapshot.currentWeek));
    res.json(dashboard(league, user.id, week, snapshot, now()));
  });

  async function pickMutation(req: Request, res: Response, deleting: boolean) {
    const user = requireUser(req);
    const league = requireLeague(req, user);
    const snapshot = await options.getSchedule();
    const at = now();
    const week = weekValue(deleting ? req.query.week : req.body.week, Math.max(league.start_week, snapshot.currentWeek));
    if (league.season !== snapshot.season || week < league.start_week || week < snapshot.currentWeek || week > Math.max(league.start_week, snapshot.currentWeek)) {
      throw publicError('Picks are open only for your league’s current week.', 409);
    }
    if (isRevealed(league.season, week, at)) throw publicError('Picks locked at Sunday 1 p.m. New York time.', 409);
    const ownStatus = memberView(league, user, user.id, week, snapshot, at);
    if (ownStatus.status === 'eliminated') throw publicError('Your entry has been eliminated.', 409);
    if (ownStatus.status === 'winner') throw publicError('This league is complete. Your entry is a winner!', 409);
    const existing = db.prepare('SELECT * FROM picks WHERE league_id=? AND user_id=? AND week=?').get(league.id, user.id, week) as unknown as PickRow | undefined;
    const existingGame = existing ? snapshot.games.find(game => game.id === existing.game_id) : undefined;
    if (existing && (!existingGame || isGameLocked(existingGame, at))) throw publicError('Your selected game has locked. This pick cannot be changed.', 409);
    if (deleting) {
      db.prepare('DELETE FROM picks WHERE league_id=? AND user_id=? AND week=?').run(league.id, user.id, week);
    } else {
      const teamId = bodyString(req.body, 'teamId', 1, 10);
      const game = snapshot.games.find(game => game.season === league.season && game.week === week && [game.homeTeamId, game.awayTeamId].includes(teamId));
      if (!game) throw publicError('That team does not have an eligible game this week.');
      if (isGameLocked(game, at)) throw publicError('That game has already started or is unavailable.', 409);
      if (db.prepare('SELECT 1 FROM picks WHERE league_id=? AND user_id=? AND team_id=? AND week<>?').get(league.id, user.id, teamId, week)) throw publicError('You have already used that team this season.', 409);
      db.prepare(`INSERT INTO picks(id,league_id,user_id,week,team_id,game_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(league_id,user_id,week) DO UPDATE SET team_id=excluded.team_id,game_id=excluded.game_id,updated_at=excluded.updated_at`)
        .run(randomUUID(), league.id, user.id, week, teamId, game.id, at.toISOString(), at.toISOString());
    }
    res.json(dashboard(league, user.id, week, snapshot, at));
  }
  app.post('/api/leagues/:id/picks', rateLimit('pick', 120, 60000), async (req, res) => { await pickMutation(req, res, false); });
  app.delete('/api/leagues/:id/picks', rateLimit('pick', 120, 60000), async (req, res) => { await pickMutation(req, res, true); });

  app.use('/api', (_req, _res, next) => { next(publicError('API route not found.', 404)); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const known = error as { status?: number; message?: string; type?: string };
    const status = Number.isInteger(known.status) && known.status! >= 400 && known.status! < 600 ? known.status! : 500;
    if (status === 500) console.error('API error:', error instanceof Error ? error.message : 'Unknown error');
    res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : known.type === 'entity.parse.failed' ? 'Invalid JSON request.' : known.message || 'Request failed.' });
  });
  return { app, db, close: () => db.close() };
}
