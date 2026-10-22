# Survivor Club

A private NFL survivor app: one team each week, no reuse, and one loss eliminates your entry. Compete with friends in invite-only leagues. Opponents' picks stay on the server until **Sunday at 1 p.m. America/New_York**, with daylight saving time handled automatically.

## Free hosting with Vercel and Supabase

Follow [the free hosting setup](docs/FREE_HOSTING.md) to create a Vercel Hobby website and a Supabase Free project. The repository includes the Vercel API, database migrations, email/password authentication with confirmation and recovery, secure pick rules, and a portrait uploader. Account creation and project credentials are still required; committing this code alone does not configure those services.

Vercel imports the repository root and uses `vercel.json`: **Vite**, `npm run build:vercel`, output `dist`, and Node.js 24. Supabase handles accounts, Postgres data, and player portrait storage. Picks are hidden by database permissions and authenticated functions until the exact Sunday deadline. A daily cron plus a shared refresh lease on requests updates the schedule without a continuously running server. Free-tier quotas apply; real confirmation/recovery emails to friends require custom SMTP configured in Supabase.

## Run locally

Requires **Node.js 24**.

```sh
npm ci
npm run dev
```

The application listens on port **3000**. Express and Vite share one process and origin. Register with an email, display name, and a 12–128 character password, create a league, share its invite code, and make a team pick. A clearly labeled demo is available before registration; its preview picks stay in browser memory and never affect a real league; its league members are illustrative while schedules and odds come from the NFL feed.

```sh
npm test          # deterministic domain, data, and HTTP integration tests
npm run build    # TypeScript check and production client build
npm start        # serve production build; HTTPS is required for session cookies
npm run test:hosted-db # isolated real PostgreSQL tests; requires Docker
npm run build:vercel   # small static build plus the configured serverless API
npm run sync:data
npm run sync:rosters -- --season=2026 --photos=all
```

The default local mode uses SQLite and needs no external account. For a traditional single-server deployment, supply HTTPS, `APP_ORIGIN`, and persistent storage for `DATABASE_PATH` (default `data/survivor.sqlite`). Keep the SQLite database, WAL, and backups private. Use the Supabase backend for Vercel or multiple replicas. Set `PORT` if needed. `.env.example` documents variables; the app reads injected runtime variables, not `.env` files automatically. `npm run dev:hosted` uses the Supabase backend locally once its variables are supplied. Existing SQLite accounts and leagues are not automatically migrated to Supabase.

## What works

- Supabase email/password auth with confirmation and recovery in hosted mode; salted scrypt passwords and opaque hashed sessions in local mode. Both use HttpOnly/SameSite cookies and Secure cookies in production.
- Private league creation and invitation codes, server-enforced membership authorization, JSON-only mutations, origin checks, and authentication/join rate limits.
- Weekly picks, kickoff locks, no repeat teams, win/loss/tie/missed-pick outcomes, standings, and pick history.
- Sunday reveal is enforced in API responses, including opponents' histories and early-game elimination status. There is no commissioner preview.
- Current NFL regular-season schedule, final results, and published odds snapshots. Local mode refreshes every 30 minutes; hosted requests refresh snapshots older than 30 minutes with a daily cron as backup. A dated fallback snapshot is labeled stale.
- Responsive dashboard, week navigation, matchup picker, league management, and searchable player directory with all 32 teams.

The application computes reveal and settlement on each request; it does not rely on a timer job running at exactly 1 p.m. Early games lock at kickoff. All remaining picks lock at the Sunday reveal, including Sunday-night and Monday choices. Joining closes at the league's first reveal. See [rules](docs/RULES.md) for ties, missing picks, canceled and postponed games.

## Data and images

Read [verified data sources](docs/data-sources.md), [research and Yahoo comparison](docs/RESEARCH.md), and [asset provenance](docs/assets.md). This is an independent survivor application, not a Yahoo integration. Official Yahoo help pages were verified during implementation. This app follows the chosen one-pick, one-strike format; documented differences include the regular-season-only scope and the explicit simultaneous Sunday reveal.

Odds are **informational snapshots**, not executable wagers or guaranteed live bookmaker prices. Displayed retrieval time is not the bookmaker's market timestamp. A missing quote stays unavailable. Results refresh when the upstream feed publishes finals, not play by play. Cancellation/postponement signals are not provided by the current feed; uncertain results remain pending.

The prepared roster has 3,053 records, with 3,000 verified PNG portraits including all 1,665 active players; 53 inactive records without an available portrait use a fallback. The roughly 564 MiB portrait cache is excluded from Git and Vercel builds. A fresh clone shows fallbacks until you run the roster download command or configure the Supabase Storage URL. See [hosted assets](docs/HOSTED_ASSETS.md) for the resumable uploader. Public access does not itself grant commercial image or trademark rights.

## Operations and limits

Account creation and login work locally without an external auth service. Email verification and password recovery require the hosted Supabase configuration and a working SMTP provider. Outbound pick notifications are not implemented. The app does not collect payments or place sportsbook bets.

Before deployment, run tests and the appropriate production build, follow the hosting guide, verify the intended public origin and cookie behavior, and arrange backups. Supabase Free does not include automatic backups. The repository does not create external service accounts or deploy itself.

Browser acceptance checks use Playwright and a separate test database. Start a development instance with `DATABASE_PATH=/tmp/survivor-browser.sqlite PORT=3100 npm run dev`, then run `TEST_BASE_URL=http://127.0.0.1:3100 npm run test:browser`. The configuration defaults to `/usr/bin/chromium`; set `CHROMIUM_PATH` for another installed Chromium binary. The browser flows expect an open regular-season pick window; deterministic deadline and season-boundary checks run independently in `npm test`.

A Dockerfile is also provided for single-server hosting. Mount durable storage at `/app/data`, supply `APP_ORIGIN`, and serve it through HTTPS. CI runs dependency installation, server/domain/provider tests, real PostgreSQL integration checks, TypeScript, and the Vercel client build. Browser tests also cover hosted confirmation/recovery with mocked provider responses; real email delivery and public deployment require configured accounts.
