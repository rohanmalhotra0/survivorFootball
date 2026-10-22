# Free-tier hosting: Supabase + Vercel

This deployment separates the website from its persistent data:

- **Vercel** serves the dashboard and runs short-lived API requests.
- **Supabase Auth** handles email/password accounts and sessions.
- **Supabase Postgres** stores leagues, membership, schedules, and picks. Database functions enforce membership, game locks, no team reuse, elimination, and the Sunday reveal.
- **Supabase Storage** serves the public player portraits. Player photos are public; league data and picks are not.

No always-running server is required. Pick visibility uses the database clock and `America/New_York`; a timer does not need to wake up at exactly 1 p.m. Sunday. The local SQLite development mode remains available. Existing SQLite accounts and leagues are not automatically imported into Supabase, and this setup does not delete them.

The code and configuration can be prepared without accounts. Creating the hosted projects, entering keys, and configuring email delivery require access to your own provider accounts. A successful local build is not proof that a public deployment or production login works.

## What can be free

Choose a **Supabase Free organization** and **Vercel Hobby** for a personal, noncommercial league. Keep both within their included allowances and do not enable paid add-ons or upgrade plans unless you intend to pay. A Vercel-provided `vercel.app` address avoids needing a paid website domain.

The Supabase official pricing source, checked October 22, 2026, lists:

| Free allowance | Amount or behavior | Relevance here |
| --- | --- | --- |
| Database | 500 MB per project | Stores accounts' app profiles, leagues, picks, and schedule snapshots; not PNG files |
| Storage | 1 GB | The 3,000 player PNGs total 591,700,646 bytes and fit before other uploads |
| Uncached egress | 5 GB | API and uncached Storage traffic consume the applicable allowance |
| Cached Storage egress | 5 GB | Repeated portrait downloads consume this allowance when served from cache |
| Auth monthly active users | 50,000 | Far above a single private league's 100-member cap |
| Free projects | Two active free projects across eligible owner/admin organizations | This setup needs one |
| Inactivity | May pause after one week of inactivity | Resume the project in Supabase before using an inactive league |
| Automatic database backups | Not included | Arrange your own exports/backups |

Hosting is not an unconditional promise of a $0 bill or uninterrupted availability. Recheck provider plan pages when creating projects; quotas and terms can change. The portrait library fits Storage's allocation, but image traffic still counts toward egress. Use the existing lazy image loading and monitor usage rather than enabling paid overages.

Vercel Hobby is intended for personal, noncommercial use. This app uses a daily maintenance cron plus request-triggered refreshes; it does not require a paid frequent cron schedule. No league deadline depends on when that maintenance cron actually executes.

## 1. Create the Supabase project

1. Sign in to [Supabase](https://supabase.com/dashboard), create an organization on the **Free** plan, and create a project such as `survivor-club`.
2. Pick a region near your users and Vercel's function region. Store the generated database password in your password manager; it is not a browser configuration value.
3. Open the project's **SQL Editor** and run the migrations in filename order: first [`202610220001_survivor.sql`](../supabase/migrations/202610220001_survivor.sql), then [`202610220002_schedule_refresh_lease.sql`](../supabase/migrations/202610220002_schedule_refresh_lease.sql). Alternatively, use the Supabase CLI's linked-project migration workflow and `supabase db push`. Future migrations also run in filename order; see [the database contract](../supabase/README.md).
4. Leave the Data API's exposed schema list at the normal `public` setting. **Do not expose `survivor_private`.** The application calls the public RPC functions; its private tables are not general browser APIs.
5. In the project's **Connect/API settings**, obtain the project URL and publishable API key. Obtain a server secret key only for maintenance operations. Older projects may label the equivalent keys `anon` and `service_role`.

The migration creates app profiles when Supabase Auth creates an account. It does not invent users, import local passwords, or seed a fake league. The schedule initialization is a separate maintenance step using the actual NFL source.

## 2. Configure authentication and email

In Supabase **Authentication → Sign In / Providers**, enable email/password accounts and keep email confirmation enabled.

The built-in Supabase email sender is for initial testing. The official documentation says it will only send to addresses belonging to the Supabase project's organization team, and its default limit is two messages per hour. It therefore cannot deliver confirmation or password-reset messages to an ordinary group of friends.

Before inviting real league members, configure **Authentication → Email / SMTP settings** with a provider that supports SMTP, such as one of the services listed in [Supabase's SMTP guide](https://supabase.com/docs/guides/auth/auth-smtp). Enter the SMTP host, port, username, password, sender address, and sender name in Supabase's secure settings. The SMTP password does not belong in the Vite frontend or in chat. A provider may offer a free sending allowance; it may also require a verified sender domain, which can have a separate cost. Do not disable email confirmation to disguise missing email delivery.

Once the Vercel project has its production address, configure **Authentication → URL Configuration**:

- **Site URL:** your exact production origin, for example `https://your-project.vercel.app`.
- **Redirect URL:** `https://your-project.vercel.app/api/auth/callback`.
- **Recovery redirect URL:** `https://your-project.vercel.app/api/auth/callback?next=recovery`.

Use your actual project address in place of the example. For local hosted-mode development, add the corresponding two callback URLs for the exact local origin you use, such as `http://localhost:3000`. Do not allow a broad production wildcard. If you intentionally test a Vercel preview deployment, add that preview's exact callback URLs and set its `APP_ORIGIN` consistently.

The application uses PKCE and server-managed HttpOnly cookies. Open a confirmation or recovery link in the same browser used to start that flow so its verification cookie is available. The API exchanges the code and redirects to `/?auth=confirmed`, `/?auth=recovery`, or `/?auth=error`. These status query strings are not authentication credentials.

## 3. Upload the player PNGs

The 3,000 downloaded portraits are too large to include in a serverless function bundle. Keep them in the dedicated public Storage bucket instead. See [hosted asset details](HOSTED_ASSETS.md).

The prepared cloud workspace already has the portraits. On a fresh clone, download them first with `npm run sync:rosters -- --season=2026 --photos=all`; the PNG cache is intentionally excluded from Git. From the repository root, inspect the local plan:

```sh
npm run assets:plan
```

Provide `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (or the legacy `SUPABASE_SERVICE_ROLE_KEY`) through your secure local/cloud environment. Then run:

```sh
npm run assets:upload
```

The uploader creates the **public** `player-portraits` bucket if it does not exist, permits PNG images only, and uses a 2 MiB per-object limit. It skips verified matching objects when resumed. It refuses a private bucket or an existing object with mismatching content instead of overwriting or deleting someone else's files.

Only NFL portrait PNGs belong in this bucket. Never upload a database, account export, league picks, or personal documents to it.

After uploading, inspect a known portrait, such as `3139477.png`, at:

```text
https://YOUR_PROJECT_REF.supabase.co/storage/v1/object/public/player-portraits/3139477.png
```

That URL is a template, not a deployed link. The 53 inactive roster entries without a verified portrait still use explicit fallbacks. Every active player has a cached source PNG.

## 4. Create the Vercel project

1. Sign in to [Vercel](https://vercel.com), choose a personal **Hobby** account, and import this application's GitHub repository or use the Vercel CLI's project linking flow.
2. Use the repository root. Keep the checked-in `vercel.json` routing and build configuration; it separates the static frontend from the API function.
3. Select **Node.js 24** for this application's server runtime. The deployment build is `npm run build:vercel`; the output directory is `dist`. This build excludes the locally cached player PNGs from the deployment and uses their public Storage URLs instead. Do not run the long-lived `npm run dev` server on Vercel. The Vercel API always selects the hosted backend and cannot silently fall back to SQLite.
4. Add the variables below in the project's **Settings → Environment Variables**. Scope them to Production. Add a separate matching configuration only if you intentionally enable preview or development deployments.

| Variable | Where its value comes from | Visibility |
| --- | --- | --- |
| `SUPABASE_URL` | Your Supabase project URL | Server configuration; URL itself is not a secret |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase API settings | Server configuration in this app; legacy `SUPABASE_ANON_KEY` is supported |
| `SUPABASE_SECRET_KEY` | Supabase server secret API key | **Server only**; legacy `SUPABASE_SERVICE_ROLE_KEY` is supported |
| `APP_ORIGIN` | Your exact Vercel production HTTPS origin | Server configuration; no path or wildcard |
| `CRON_SECRET` | A cryptographically random secret generated in your password manager | **Server only**; protects maintenance requests |
| `VITE_PLAYER_ASSET_BASE_URL` | `https://YOUR_PROJECT_REF.supabase.co/storage/v1/object/public/player-portraits` | Public build-time value; contains no key |

Never prefix a secret, service-role key, or SMTP password with `VITE_`. Vite variables are embedded into downloadable JavaScript. `VITE_PLAYER_ASSET_BASE_URL` is deliberately public because the portrait bucket is public.

The server's privileged key is used only for schedule maintenance and the shared authentication rate limiter. Authenticated league reads and writes use the signed-in user's Supabase identity and database RPC checks. Do not replace those calls with service-role queries to fix a permission error.

5. Deploy after the migration, variables, and image upload are ready. The first Vercel project creation may be needed to learn its exact production domain; update `APP_ORIGIN` and Supabase's allowlisted URLs to that domain, then redeploy.
6. With the same hosted variables securely injected into your local/cloud process, verify configuration and initialize the real NFL schedule:

```sh
npm run sync:hosted
npm run hosting:check
```

Keep maintenance credentials in the secure process environment, not command-line URLs or chat. `hosting:check` is a diagnostic, not proof that Vercel has received those same settings. `sync:hosted` stores the actual source schedule in Supabase; it does not create sample user picks.

For a local check against your own Supabase project, set `APP_ORIGIN` to your local origin and run `npm run dev:hosted`. This selects `APP_BACKEND=supabase`. The ordinary `npm run dev` command retains local SQLite development unless that variable is explicitly set.

## 5. Verify the public deployment

A successful upload or build is not the final check. On the real HTTPS address:

1. Check `/api/health` for the hosted backend and visit the dashboard. Verify the schedule source, current week, and freshness indicator.
2. Register with an address that is **not** a member of the Supabase organization. Receive and complete confirmation in the same browser. This tests your real SMTP setup rather than the restricted built-in sender.
3. Sign in, create a private league, copy its invite code, and make a pick. Reload to confirm the pick persists.
4. Join with a second account. Confirm the first account's current pick is sealed both in the page and its API response before Sunday at 1 p.m. New York time.
5. Sign out and back in. Request a password reset and confirm that the recovery flow completes.
6. Verify a portrait loads from the public Storage bucket and the rest of the dashboard loads from Vercel.
7. Review usage in both provider dashboards, record how to resume a paused Supabase project, and arrange a database export before relying on a season's results.

The automated local suites cover precise deadline/DST boundaries and concurrent pick constraints. Live verification still matters because provider settings, SMTP, DNS, secret values, and deployed origins cannot be proven by local tests.

## Verified sources and limits of this setup

Research checked October 22, 2026:

- [Supabase official pricing source](https://github.com/supabase/supabase/blob/master/packages/shared-data/pricing.ts): Free database, Storage, egress, Auth, pausing, and backup allowances.
- [Supabase billing documentation](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/platform/billing-on-supabase.mdx): free-project count and organization billing model.
- [Supabase SMTP documentation](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/auth-smtp.mdx): built-in sender restrictions and custom SMTP setup.
- [Supabase official shared configuration](https://github.com/supabase/supabase/blob/master/packages/shared-data/config.ts): built-in email rate and inactivity duration.
- [Supabase redirect URL guidance](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/redirect-urls.mdx): exact production redirects are recommended.
- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby), [cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [function limits](https://vercel.com/docs/functions/limitations), and [Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions): provider settings to check when creating the account. These website pages were initially blocked by the build environment; do not treat an unverified numeric Vercel quota as a measured deployment result.

No hosted account, project, public deployment, SMTP sender, or payment method is created merely by adding these files. Deployment and hosted acceptance remain pending until the required provider accounts and settings exist.
