import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const stage = resolve(root, '.hosting/public');
// Only this script's generated staging directory is replaced.
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(resolve(root, 'public'), stage, {
  recursive: true,
  filter: (source) => !/^assets\/players\/[^/]+\.png$/i.test(relative(resolve(root, 'public'), source).replaceAll('\\', '/')),
});
const buildEnv: NodeJS.ProcessEnv = { ...process.env, HOSTING_TARGET: 'vercel' };
if (!buildEnv.VITE_PLAYER_ASSET_BASE_URL && buildEnv.SUPABASE_URL) {
  const origin = new URL(buildEnv.SUPABASE_URL);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('SUPABASE_URL must be the HTTPS project origin.');
  buildEnv.VITE_PLAYER_ASSET_BASE_URL = `${origin.origin}/storage/v1/object/public/player-portraits`;
}
for (const args of [['run', 'check'], ['exec', '--', 'vite', 'build']]) {
  const run = spawnSync('npm', args, { cwd: root, env: buildEnv, stdio: 'inherit' });
  if (run.error || run.status !== 0) process.exit(run.status || 1);
}
async function directorySize(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async entry => entry.isDirectory() ? directorySize(resolve(directory, entry.name)) : (await stat(resolve(directory, entry.name))).size));
  return sizes.reduce((sum, size) => sum + size, 0);
}
const bytes = await directorySize(resolve(root, 'dist'));
console.log(`Vercel static output: ${(bytes / 1024 / 1024).toFixed(2)} MiB. Player PNGs are served from the configured public asset bucket.`);
if (!buildEnv.VITE_PLAYER_ASSET_BASE_URL) console.warn('Player asset storage is not configured; hosted player cards will use placeholders until SUPABASE_URL is set and assets are uploaded.');
