import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient, type User as SupabaseUser } from '@supabase/supabase-js';
import type { Request, Response } from 'express';
import type { HostedConfig } from './config.js';
import type { User } from '../../shared/types.js';

export function readRequestCookies(header: string | undefined): { name: string; value: string }[] {
  if (!header) return [];
  return header.split(';').flatMap(part => {
    const separator = part.indexOf('=');
    if (separator < 1) return [];
    const name = part.slice(0, separator).trim();
    if (!name) return [];
    try { return [{ name, value: decodeURIComponent(part.slice(separator + 1).trim()) }]; }
    catch { return []; }
  });
}

/** A fresh user-scoped client per request; its JWT is never replaced with a service key. */
export function createSupabaseRequestClient(req: Request, res: Response, config: HostedConfig): SupabaseClient {
  const cookies = new Map(readRequestCookies(req.headers.cookie).map(cookie => [cookie.name, cookie.value]));
  return createServerClient(config.supabaseUrl, config.publishableKey, {
    auth: { flowType: 'pkce', autoRefreshToken: false, detectSessionInUrl: false, persistSession: true },
    cookieOptions: { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' },
    cookies: {
      getAll() { return [...cookies].map(([name, value]) => ({ name, value })); },
      setAll(updates) {
        for (const { name, value, options } of updates) {
          cookies.set(name, value);
          // SSR serializes maxAge in seconds; Express expects milliseconds.
          res.cookie(name, value, {
            ...options,
            ...(typeof options.maxAge === 'number' ? { maxAge: options.maxAge * 1000 } : {}),
            httpOnly: true,
            secure: config.cookieSecure,
            sameSite: 'lax',
            path: '/',
          });
        }
      },
    },
  });
}

/** This client is reserved for server-owned maintenance and anonymous rate limits. */
export function createSupabaseAdminClient(config: HostedConfig): SupabaseClient {
  if (!config.serviceRoleKey) throw new Error('SUPABASE_SECRET_KEY is required for server-side rate limiting and schedule refresh.');
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function publicUser(user: SupabaseUser): User {
  const metadataName = user.user_metadata?.name;
  const name = typeof metadataName === 'string' && metadataName.trim() ? metadataName.trim().slice(0, 40) : (user.email?.split('@')[0] || 'League member');
  return { id: user.id, name, email: user.email || '' };
}
