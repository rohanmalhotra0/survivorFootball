import { loadHostedConfig } from '../server/hosted/config.js';
import { scheduleServiceClient } from '../server/hosted/schedule.js';

try {
  loadHostedConfig({ ...process.env, NODE_ENV: 'production' });
  const client = scheduleServiceClient();
  const { data, error } = await client.rpc('survivor_schedule');
  if (error) throw new Error('Supabase is unreachable or the database migration has not been applied.');
  if (!Array.isArray(data?.games) || !data.games.length) throw new Error('Supabase is connected, but has no schedule. Run npm run sync:hosted.');
  console.log(JSON.stringify({ configuration: 'valid', database: 'connected', scheduleGames: data.games.length, season: data.season, stale: data.stale, cronConfigured: Boolean(process.env.CRON_SECRET), emailDelivery: 'must be tested in the Supabase project', publicDeployment: 'not verified by this check' }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Hosted configuration could not be verified.');
  process.exitCode = 1;
}
