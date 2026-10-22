# Player PNGs on free hosting

The app keeps its original player PNGs locally and serves hosted portraits from a dedicated **public Supabase Storage bucket**. This avoids shipping roughly 592 MB of portraits inside Vercel's application upload or server function. The website's team logos, fonts, and explicit missing-portrait fallback remain ordinary static assets.

The verified asset plan contains **3,000 portraits, 591,700,646 bytes (564.29 MiB)**. All 1,665 active player records have a portrait. Another 53 inactive records have no verified portrait and retain their fallback. The largest current PNG is 401,439 bytes. These numbers describe the existing snapshot; rerun the plan after refreshing rosters.

## Prepare and inspect

From the repository root, with Node.js 24+ and dependencies installed:

```sh
npm run assets:plan
# Equivalent:
NODE_USE_ENV_PROXY=1 npx tsx scripts/upload-player-assets.ts --dry-run
```

A dry run is the default. It needs no project credentials and makes **no network requests or storage changes**. It enumerates only PNG paths already referenced by the player roster, rejects symlinks and unsafe paths, verifies PNG signatures/header/end chunks, and computes SHA256 checksums. Unrelated files in the asset directory are not upload candidates.

The original PNG files are never rewritten or removed by this script.

## Upload to your Supabase project

Create the Supabase project first. In the secure environment used to run the upload, supply:

- `SUPABASE_URL`: the project's HTTPS origin, such as `https://your-project.supabase.co`.
- `SUPABASE_SECRET_KEY`: the project's server-only secret key. Legacy projects can use `SUPABASE_SERVICE_ROLE_KEY` instead.

Never put either secret-key variable in browser code, a `VITE_` variable, a committed `.env` file, chat, or a screenshot. The URL is public information. A publishable/anon key cannot administer Storage and is not suitable for this command.

```sh
npm run assets:upload
# Equivalent:
NODE_USE_ENV_PROXY=1 npx tsx scripts/upload-player-assets.ts --apply
```

The command creates the `player-portraits` bucket if absent, with public downloads, PNG-only uploads, and a 2 MiB per-object limit. It **does not** modify existing bucket settings. If a bucket with that name already exists and is private, the command stops rather than exposing its contents. Review an existing bucket before deliberately making it public, or use a fresh project dedicated to this app.

Only public player portraits belong in this bucket. Do not store account records, picks, private photos, database backups, credentials, or user uploads there. Public read access does not require anonymous upload/delete policies; do not grant browser users storage-write access.

Uploads use four workers and at most four attempts for transient network, HTTP 429, or HTTP 5xx errors. Authorization errors stop the upload queue. API response bodies, credentials, and request headers are not logged.

## Resume safely

The uploader lists existing object names and sizes before writing. Same-name objects with a different size cause a failure. Existing matching-size objects are checked against SHA256 metadata; objects without that metadata are downloaded and hashed rather than trusted by size alone. Uploads use `upsert: false`, so this script never overwrites or deletes existing objects.

If an interrupted request actually completed on the server, a subsequent duplicate response triggers existing-object verification and is counted as reuse. Rerunning the command resumes safely. A failed run may have uploaded some valid files before stopping; those remain available for the next run.

A portrait that changes after a future roster refresh needs an explicit version/replacement decision. The uploader intentionally does not silently replace an existing public image. Local sources are rechecked immediately before uploading so a file changed during planning cannot be mistaken for its earlier checksum.

## Configure the website

After a successful upload, set this **non-secret Vercel build variable**:

```text
VITE_PLAYER_ASSET_BASE_URL=https://your-project.supabase.co/storage/v1/object/public/player-portraits
```

The frontend maps a local path such as `/assets/players/3139477.png` to the same filename beneath that base URL. This variable contains no secret key. External source URLs and the local fallback SVG are not rewritten.

Rebuild/redeploy after changing the variable. Verify a known public object directly, for example:

```text
https://your-project.supabase.co/storage/v1/object/public/player-portraits/3139477.png
```

Then check the dashboard hero and a player search from the deployed website. Missing images must show the documented fallback rather than break the page.

The hosted Vite build must omit local player PNGs from its output, and the Vercel upload configuration must exclude them from the uploaded source. Keeping them out of the function bundle alone is insufficient. See [free-hosting setup](FREE_HOSTING.md) for the complete deployment path.

## Capacity and verification limits

This portrait snapshot fits inside Supabase's documented 1 GB Free file-storage allocation, but any other buckets also consume that allocation. The script reports estimated new bytes; it does not calculate account-wide usage, purchase capacity, alter a subscription, or guarantee free bandwidth. Rechecking legacy objects without checksum metadata downloads their bytes and consumes bandwidth. Review Storage and egress usage in the Supabase dashboard.

The dry run and local mock-storage checks can be completed without a hosted project. Actual bucket creation, upload, public-image access, and deployed frontend resolution remain unverified until a real project and securely supplied server credentials are available. A successful local plan does not mean the images were published.

Photograph and logo rights remain with their respective owners; public endpoints and open archives do not automatically provide commercial image licenses. Source and portrait-identity safeguards are documented in [asset provenance](assets.md).
