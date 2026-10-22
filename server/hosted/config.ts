/** These values are server-only. Never serialize the configuration into an API response. */
export interface HostedConfig {
  supabaseUrl: string;
  publishableKey: string;
  serviceRoleKey?: string;
  appOrigin: string;
  cookieSecure: boolean;
}

export class HostedConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedConfigurationError';
  }
}

function cleanOrigin(value: string, name: string, production: boolean): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new HostedConfigurationError(`${name} must be a valid origin URL.`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !production))
    || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new HostedConfigurationError(`${name} must be an HTTPS origin without a path, query, or credentials.`);
  }
  return url.origin;
}

export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const production = env.NODE_ENV === 'production' || env.VERCEL === '1';
  const missing: string[] = [];
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  const serviceRoleKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!publishableKey) missing.push('SUPABASE_PUBLISHABLE_KEY');
  if (!serviceRoleKey) missing.push('SUPABASE_SECRET_KEY');
  const productionOrigin = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined;
  const appOrigin = env.APP_ORIGIN || productionOrigin || (!production ? `http://localhost:${env.PORT || '3000'}` : undefined);
  if (!appOrigin) missing.push('APP_ORIGIN');
  if (missing.length) throw new HostedConfigurationError(`Hosted configuration is incomplete: ${missing.join(', ')}.`);
  // A service key must never become the default identity for user-scoped clients.
  let legacyRole: unknown;
  try { legacyRole = JSON.parse(Buffer.from(publishableKey!.split('.')[1] || '', 'base64url').toString('utf8')).role; }
  catch { /* New publishable keys are not JWTs. */ }
  if (publishableKey!.startsWith('sb_secret_') || legacyRole === 'service_role') {
    throw new HostedConfigurationError('SUPABASE_PUBLISHABLE_KEY must be a publishable or legacy anon key, never a secret/service-role key.');
  }
  return {
    supabaseUrl: cleanOrigin(supabaseUrl!, 'SUPABASE_URL', production),
    publishableKey: publishableKey!,
    serviceRoleKey,
    appOrigin: cleanOrigin(appOrigin!, 'APP_ORIGIN', production),
    cookieSecure: production,
  };
}
