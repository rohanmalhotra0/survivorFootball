import { randomBytes, scrypt as nodeScrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response } from 'express';
import type { Database } from './database.js';

const scrypt = promisify(nodeScrypt);
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const COOKIE = 'survivor_session';
// A real scrypt workload also runs when the account is absent, reducing account enumeration.
const DUMMY_HASH = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;

export interface AuthUser { id: string; name: string; email: string }

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored?: string): Promise<boolean> {
  const [kind, salt, digest] = (stored || DUMMY_HASH).split(':');
  if (kind !== 'scrypt' || !salt || !digest) return false;
  const derived = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(digest, 'hex');
  return expected.length === derived.length && timingSafeEqual(expected, derived) && Boolean(stored);
}

export function sessionToken(req: Request): string | null {
  const raw = req.headers.cookie || '';
  const token = raw.split(';').map(c => c.trim()).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function digest(token: string) { return createHash('sha256').update(token).digest('hex'); }

function cookieOptions(req: Request) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: req.secure || process.env.NODE_ENV === 'production', path: '/' };
}

export function createSession(db: Database, req: Request, res: Response, userId: string, now: Date) {
  const old = sessionToken(req);
  if (old) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(old));
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(
    digest(token), userId, new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString(),
  );
  res.cookie(COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_SECONDS * 1000 });
}

export function readUser(db: Database, req: Request, now: Date): AuthUser | null {
  const token = sessionToken(req);
  if (!token) return null;
  const row = db.prepare(`SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(digest(token), now.toISOString());
  return row ? row as unknown as AuthUser : null;
}

export function logout(db: Database, req: Request, res: Response) {
  const token = sessionToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
  res.clearCookie(COOKIE, cookieOptions(req));
}
