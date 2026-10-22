/** Upload only the app's verified public player portraits to a dedicated Supabase bucket. */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NFL_PLAYERS, ROSTER_ASSET_STATUS } from '../shared/players.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUCKET = 'player-portraits';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SHA256 = /^[a-f0-9]{64}$/;

export interface PortraitFile { name: string; path: string; size: number; sha256: string }
export interface PortraitPlan { files: PortraitFile[]; totalBytes: number; largestFileBytes: number }
export interface UploadConfig { url: string; key: string }

/** Reject corrupt/non-PNG input before sending any bytes to storage. */
export function verifyPng(bytes: Buffer, name: string): void {
  if (bytes.length < 45 || bytes.length > MAX_FILE_BYTES
    || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1
    || !bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) {
    throw new Error(`Invalid or oversized PNG: ${name}. No upload was attempted for this file.`);
  }
}

/** Only local PNG paths referenced by the roster are eligible; arbitrary directory contents are ignored. */
export async function buildPortraitPlan(root = ROOT): Promise<PortraitPlan> {
  const directory = await realpath(resolve(root, 'public/assets/players'));
  const names = [...new Set(NFL_PLAYERS.flatMap(player => {
    if (!player.headshot.startsWith('/assets/players/') || !player.headshot.endsWith('.png')) return [];
    const name = player.headshot.slice('/assets/players/'.length);
    if (!/^[A-Za-z0-9_-]+\.png$/.test(name)) throw new Error('Roster contains an unsafe local portrait path.');
    return [name];
  }))].sort();
  if (!names.length) throw new Error('No local player PNGs are referenced by the roster.');
  const files: PortraitFile[] = [];
  for (const name of names) {
    const path = resolve(directory, name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || dirname(await realpath(path)) !== directory) {
      throw new Error(`Refusing a non-regular or redirected portrait: ${name}.`);
    }
    const bytes = await readFile(path);
    verifyPng(bytes, name);
    files.push({ name, path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { files, totalBytes: files.reduce((sum, file) => sum + file.size, 0), largestFileBytes: Math.max(...files.map(file => file.size)) };
}

export function readUploadConfig(environment: NodeJS.ProcessEnv = process.env): UploadConfig {
  const rawUrl = environment.SUPABASE_URL;
  const key = environment.SUPABASE_SECRET_KEY || environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !key) throw new Error('Set SUPABASE_URL and server-only SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) securely before using --apply. Never paste secret keys into chat.');
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('SUPABASE_URL must be your HTTPS Supabase project URL.'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co') || url.username || url.password
    || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('SUPABASE_URL must be an HTTPS project origin on supabase.co, with no credentials, query, or path.');
  }
  if (key.startsWith('sb_publishable_')) throw new Error('Portrait uploads require a server-only secret key, not a publishable key.');
  // This is only a mistaken-key check, not JWT verification. Proxy-backed credential placeholders remain supported.
  if (key.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
      if (payload.role === 'anon' || payload.role === 'authenticated') throw new Error('PUBLIC_KEY');
    } catch (error) {
      if (error instanceof Error && error.message === 'PUBLIC_KEY') throw new Error('Portrait uploads require a server-only service-role key, not an anonymous/user key.');
    }
  }
  return { url: url.origin, key };
}

function statusOf(error: unknown): number {
  const details = error as { status?: unknown; statusCode?: unknown } | null;
  const value = Number(details?.statusCode ?? details?.status);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 0;
}
function codeOf(error: unknown): string {
  return typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : '';
}
class StorageOperationError extends Error {
  constructor(public readonly status: number, operation: string) {
    super(`Storage ${operation} failed${status ? ` (HTTP ${status})` : ' (network or unexpected response)'}. ${status === 401 || status === 403 ? 'Check the server-only key and project access in secure settings.' : 'No existing object was overwritten; rerun after resolving the service error.'}`);
  }
}

export async function uploadPortraits(plan: PortraitPlan, config: UploadConfig, options: { fetch?: typeof fetch; log?: (message: string) => void } = {}) {
  const { createClient } = await import('@supabase/supabase-js');
  const controller = new AbortController();
  const log = options.log || console.log;
  const upstreamFetch = options.fetch || fetch;
  const guardedFetch: typeof fetch = (input, init) => upstreamFetch(input, {
    ...init,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : [])]),
  });
  const client = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: guardedFetch },
  });

  async function checked<T>(operation: string, action: () => Promise<{ data: T | null; error: unknown }>): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (controller.signal.aborted) throw new Error('Upload stopped after another storage operation failed.');
      let result: { data: T | null; error: unknown };
      try { result = await action(); } catch { result = { data: null, error: null }; }
      if (!result.error && result.data !== null) return result.data;
      const status = statusOf(result.error);
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt === 3) throw new StorageOperationError(status, operation);
      await new Promise(resolveWait => setTimeout(resolveWait, Math.min(8000, 500 * 2 ** attempt)));
    }
    throw new Error('Storage retry limit reached.');
  }

  const found = await client.storage.getBucket(BUCKET);
  if (found.error) {
    const missing = statusOf(found.error) === 404 || codeOf(found.error) === 'NoSuchBucket'
      || (statusOf(found.error) === 400 && found.error.message === 'Bucket not found');
    if (!missing) throw new StorageOperationError(statusOf(found.error), 'bucket lookup');
    const created = await client.storage.createBucket(BUCKET, { public: true, allowedMimeTypes: ['image/png'], fileSizeLimit: MAX_FILE_BYTES });
    if (created.error && statusOf(created.error) !== 409 && codeOf(created.error) !== 'BucketAlreadyExists') {
      throw new StorageOperationError(statusOf(created.error), 'bucket creation');
    }
  }
  const bucket = await checked('bucket verification', () => client.storage.getBucket(BUCKET));
  if (bucket.public !== true) throw new Error('The existing player-portraits bucket is private. It was not changed or exposed. Use a dedicated public portrait bucket after reviewing its contents.');
  if (bucket.file_size_limit && bucket.file_size_limit < plan.largestFileBytes) throw new Error('The existing portrait bucket file-size limit is too small. Review its settings; this script will not change an existing bucket.');
  if (bucket.allowed_mime_types?.length && !bucket.allowed_mime_types.some(type => type === 'image/png' || type === 'image/*')) {
    throw new Error('The existing portrait bucket does not permit PNGs. Review its settings; this script will not change an existing bucket.');
  }
  const storage = client.storage.from(BUCKET);
  const existing = new Map<string, { size: number }>();
  for (let offset = 0; ; offset += 1000) {
    const entries = await checked('object listing', () => storage.list('', { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }));
    for (const entry of entries) if (entry.id && entry.metadata && !entry.is_delete_marker) existing.set(entry.name, { size: Number(entry.metadata.size) });
    if (entries.length < 1000) break;
  }
  // Fail before uploading anything if a same-name object already has a different size.
  for (const file of plan.files) {
    const remote = existing.get(file.name);
    if (remote && remote.size !== file.size) throw new Error(`Existing object differs from this portrait: ${file.name}. Nothing was overwritten. Resolve the conflict explicitly before retrying.`);
  }
  const newFiles = plan.files.filter(file => !existing.has(file.name));
  log(JSON.stringify({ bucket: BUCKET, eligibleFiles: plan.files.length, newFiles: newFiles.length, estimatedNewBytes: newFiles.reduce((sum, file) => sum + file.size, 0), existingToVerify: plan.files.length - newFiles.length }));
  log('Only verified public player portraits are uploaded. Other buckets and account-wide quotas are not changed or checked.');

  async function verifyExisting(file: PortraitFile) {
    const details = await checked('object verification', () => storage.info(file.name));
    if (Number(details.size ?? details.metadata?.size) !== file.size) throw new Error(`Existing object differs from this portrait: ${file.name}. Nothing was overwritten.`);
    const recordedHash = details.metadata?.sha256;
    if (typeof recordedHash === 'string' && SHA256.test(recordedHash)) {
      if (recordedHash !== file.sha256) throw new Error(`Existing object checksum differs: ${file.name}. Nothing was overwritten.`);
      return;
    }
    // Older/manual uploads may not carry our SHA256 metadata. Verify bytes instead of trusting size alone.
    const blob = await checked('existing object download', () => storage.download(file.name));
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error(`Existing object checksum differs: ${file.name}. Nothing was overwritten.`);
    }
  }

  let next = 0; let uploaded = 0; let reused = 0; let firstFailure: Error | null = null;
  async function worker() {
    while (next < plan.files.length && !controller.signal.aborted) {
      const file = plan.files[next++];
      try {
        if (existing.has(file.name)) { await verifyExisting(file); reused++; }
        else {
          const bytes = await readFile(file.path);
          verifyPng(bytes, file.name);
          if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
            throw new Error(`Local portrait changed after planning: ${file.name}. Rerun the plan before uploading.`);
          }
          try {
            await checked('portrait upload', () => storage.upload(file.name, bytes, {
              upsert: false, contentType: 'image/png', cacheControl: '31536000', metadata: { sha256: file.sha256, asset: 'survivor-player-portrait' },
            }));
            uploaded++;
          } catch (error) {
            // Another uploader, or a completed request whose response was lost, may have created the same object.
            if (!(error instanceof StorageOperationError) || error.status !== 409) throw error;
            await verifyExisting(file); reused++;
          }
        }
        if ((uploaded + reused) % 100 === 0) log(`Portrait progress: ${uploaded + reused}/${plan.files.length}; uploaded ${uploaded}, reused ${reused}.`);
      } catch (error) {
        firstFailure ??= error instanceof Error ? error : new Error('Portrait upload failed.');
        controller.abort();
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, plan.files.length) }, worker));
  if (firstFailure) throw firstFailure;
  const publicBase = `${config.url}/storage/v1/object/public/${BUCKET}`;
  log(JSON.stringify({ status: 'complete', uploaded, reused, total: plan.files.length, publicAssetBase: publicBase }));
  log(`Set the non-secret Vercel build variable VITE_PLAYER_ASSET_BASE_URL=${publicBase}`);
  return { uploaded, reused, publicBase };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Use --dry-run (default) to inspect local portraits, or --apply to upload them.');
  }
  const plan = await buildPortraitPlan();
  console.log(JSON.stringify({
    mode: args.includes('--apply') ? 'apply' : 'dry-run', bucket: BUCKET,
    portraitCount: plan.files.length, totalBytes: plan.totalBytes,
    totalMiB: Number((plan.totalBytes / 1024 / 1024).toFixed(2)), largestFileBytes: plan.largestFileBytes,
    activePlayersCovered: ROSTER_ASSET_STATUS.activeLocalPngs,
    inactiveRecordsUsingFallbacks: ROSTER_ASSET_STATUS.remoteOrUnavailable,
    source: 'Existing local PNGs referenced by the application roster only',
  }, null, 2));
  if (!args.includes('--apply')) { console.log('Dry run complete. No network requests, bucket changes, or uploads were made.'); return; }
  await uploadPortraits(plan, readUploadConfig());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Do not dump SDK errors, request headers, environment values, or secret-bearing URLs.
    console.error(error instanceof Error ? error.message : 'Portrait upload failed.');
    process.exitCode = 1;
  });
}
