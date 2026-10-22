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
