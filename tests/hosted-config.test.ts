import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHostedConfig } from '../server/hosted/config.js';

const production = {
  NODE_ENV: 'production', VERCEL: '1',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_private-test-value',
  VERCEL_PROJECT_PRODUCTION_URL: 'survivor.example.test',
};

test('hosted configuration rejects secret keys as user identities without revealing their value', () => {
  const serviceJwt = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.private-signature`;
  for (const publishableKey of ['sb_secret_private-test-value', serviceJwt]) {
    assert.throws(() => loadHostedConfig({ ...production, SUPABASE_PUBLISHABLE_KEY: publishableKey }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /never a secret\/service-role key/);
      assert.ok(!error.message.includes(publishableKey));
      return true;
    });
  }
});

test('hosted production configuration uses the stable deployment origin and fails closed when incomplete', () => {
  const config = loadHostedConfig(production);
  assert.equal(config.appOrigin, 'https://survivor.example.test');
  assert.equal(config.cookieSecure, true);
  assert.throws(() => loadHostedConfig({ ...production, SUPABASE_SECRET_KEY: undefined }), /SUPABASE_SECRET_KEY/);
  for (const appOrigin of ['http://survivor.example.test', 'https://user:password@survivor.example.test', 'https://survivor.example.test/path']) {
    assert.throws(() => loadHostedConfig({ ...production, APP_ORIGIN: appOrigin }), /HTTPS origin/);
  }
});

test('hosted configuration accepts Supabase quickstart public aliases while requiring a private service key', () => {
  const quickstart = {
    ...production,
    SUPABASE_URL: undefined,
    SUPABASE_PUBLISHABLE_KEY: undefined,
    NEXT_PUBLIC_SUPABASE_URL: 'https://quickstart.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_quickstart-fixture',
  };
  const config = loadHostedConfig(quickstart);
  assert.equal(config.supabaseUrl, quickstart.NEXT_PUBLIC_SUPABASE_URL);
  assert.equal(config.publishableKey, quickstart.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  assert.equal(config.serviceRoleKey, production.SUPABASE_SECRET_KEY);
  assert.throws(() => loadHostedConfig({
    ...quickstart,
    SUPABASE_SECRET_KEY: undefined,
    NEXT_PUBLIC_SUPABASE_SECRET_KEY: 'sb_secret_unsupported-public-fixture',
  }), /SUPABASE_SECRET_KEY/);
});

test('canonical configuration takes precedence over aliases and legacy anon keys remain supported', () => {
  const config = loadHostedConfig({
    ...production,
    NEXT_PUBLIC_SUPABASE_URL: 'https://unused.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unused-fixture',
    SUPABASE_ANON_KEY: 'legacy-anon-unused-fixture',
  });
  assert.equal(config.supabaseUrl, production.SUPABASE_URL);
  assert.equal(config.publishableKey, production.SUPABASE_PUBLISHABLE_KEY);

  const legacyAnon = `header.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.fixture-signature`;
  assert.equal(loadHostedConfig({
    ...production,
    SUPABASE_PUBLISHABLE_KEY: undefined,
    SUPABASE_ANON_KEY: legacyAnon,
  }).publishableKey, legacyAnon);
  assert.equal(loadHostedConfig({
    ...production,
    SUPABASE_PUBLISHABLE_KEY: undefined,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_preferred-fixture',
    SUPABASE_ANON_KEY: legacyAnon,
  }).publishableKey, 'sb_publishable_preferred-fixture');
});

test('public aliases receive the same secret-key and HTTPS validation as canonical values', () => {
  const serviceJwt = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.alias-private-signature`;
  for (const publishableKey of ['sb_secret_alias-private-fixture', serviceJwt]) {
    assert.throws(() => loadHostedConfig({
      ...production,
      SUPABASE_PUBLISHABLE_KEY: undefined,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
      SUPABASE_ANON_KEY: 'legacy-anon-fallback-fixture',
    }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /never a secret\/service-role key/);
      assert.ok(!error.message.includes(publishableKey));
      return true;
    });
  }
  assert.throws(() => loadHostedConfig({
    ...production,
    SUPABASE_URL: undefined,
    NEXT_PUBLIC_SUPABASE_URL: 'http://quickstart.supabase.co',
  }), /HTTPS origin/);
});
