import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { createHostedApp } from '../server/hosted/app.js';

function close(server: Server) { return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
function baseUrl(server: Server) { const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`; }

test('real Supabase SSR adapter creates protected cookies, authenticates from them, and clears them on logout', async t => {
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.test', aud: 'authenticated', role: 'authenticated', user_metadata: { name: 'Alice' }, app_metadata: {}, created_at: '2026-10-22T00:00:00Z' };
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ sub: user.id, aud: 'authenticated', exp: Math.floor(Date.now()/1000)+3600, role: 'authenticated' })}.controlled-test-signature`;
  let userRequests = 0;
  // A controlled Auth HTTP boundary exercises the actual Supabase SDK/SSR cookie
  // implementation. This is not a claim that an external Supabase project exists.
  const provider = createServer((req,res) => {
    const path = new URL(req.url || '/', 'http://provider.test').pathname;
    res.setHeader('Content-Type','application/json');
    if (path === '/auth/v1/token') {
      res.end(JSON.stringify({ access_token: jwt, refresh_token: 'test-refresh-token', token_type: 'bearer', expires_in: 3600, user }));
    } else if (path === '/auth/v1/user') {
      userRequests++;
      if (req.headers.authorization !== `Bearer ${jwt}`) { res.statusCode=401; res.end(JSON.stringify({ message: 'Invalid token' })); }
      else res.end(JSON.stringify(user));
    } else if (path === '/auth/v1/logout') { res.statusCode=204; res.end(); }
    else { res.statusCode=404; res.end(JSON.stringify({ message: 'Unexpected provider endpoint' })); }
  }).listen(0,'127.0.0.1');
  await once(provider,'listening'); t.after(() => close(provider));
  const app = createHostedApp({
    config: { supabaseUrl: baseUrl(provider), publishableKey: 'test-publishable-key', appOrigin: 'https://survivor.example.test', cookieSecure: true },
    getSchedule: async () => ({ season: 2026,currentWeek: 7,games: [],source: 'fixture',stale: false,updatedAt: new Date().toISOString() }),
    enforceRateLimit: async () => ({ allowed: true,retryAfter: 0 }),
  });
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening'); t.after(() => close(server));
  const origin = baseUrl(server);
  const signedIn = await fetch(origin+'/api/auth/login', { method: 'POST',headers: { 'Content-Type':'application/json',Origin:'https://survivor.example.test' },body: JSON.stringify({ email:user.email,password:'Long-test-password-2026!' }) });
  assert.equal(signedIn.status,200);
  const body = await signedIn.json();
  assert.deepEqual(body.user,{ id:user.id,name:'Alice',email:user.email });
  assert.doesNotMatch(JSON.stringify(body),/access_token|refresh_token|controlled-test-signature/);
  const cookies = signedIn.headers.getSetCookie();
  assert.ok(cookies.length>0);
  for (const cookie of cookies) {
    assert.match(cookie,/HttpOnly/i); assert.match(cookie,/Secure/i); assert.match(cookie,/SameSite=Lax/i); assert.match(cookie,/Path=\//i);
    const maxAge=Number(cookie.match(/Max-Age=(\d+)/i)?.[1]);
    if (maxAge) assert.ok(maxAge>=86_400 && maxAge<40_000_000,'Cookie lifetime must retain its intended days-long duration when converting between SDK seconds and Express milliseconds.');
  }
  const cookieHeader=cookies.map(cookie=>cookie.split(';')[0]).join('; ');
  const me=await fetch(origin+'/api/auth/me',{ headers:{Cookie:cookieHeader} });
  assert.equal(me.status,200); assert.equal((await me.json()).user.id,user.id);
  assert.ok(userRequests>0,'Session identity must be verified with Auth, not merely decoded from a cookie.');
  const signedOut=await fetch(origin+'/api/auth/logout',{ method:'POST',headers:{Cookie:cookieHeader,'Content-Type':'application/json',Origin:'https://survivor.example.test'} });
  assert.equal(signedOut.status,200);
  assert.ok(signedOut.headers.getSetCookie().some(cookie=>/Max-Age=0/i.test(cookie)),'Sign-out must clear the browser session cookie.');
});
