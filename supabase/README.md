# Survivor Club database

Apply `migrations/202610220001_survivor.sql`, then `migrations/202610220002_schedule_refresh_lease.sql`, to the selected Supabase project with its migration owner (SQL Editor or `supabase db push`). Apply each migration once. The migration is transactional and deliberately fails on an existing conflicting schema rather than dropping live data.

Keep the Supabase API's exposed schema list at its normal `public` setting. **Do not expose `survivor_private`.** No client has direct schema or table privileges there, and every table also has row-level security enabled without a client bypass policy. Raw picks, submission counts, invite codes, and profile membership cannot be fetched or streamed through the data API. The public RPCs perform the exact permitted operations.

## RPC contract

Successful return values use the same camelCase JSON as `shared/types.ts`.

| Function | Arguments | Result | Caller |
| --- | --- | --- | --- |
| `survivor_schedule` | none | `ScheduleSnapshot` | Anonymous or signed-in user |
| `survivor_list_leagues` | none | `{ leagues }` | Signed-in user |
| `survivor_create_league` | `p_name` | `{ league }` | Signed-in user |
| `survivor_join_league` | `p_invite_code` | `{ league }` | Signed-in user |
| `survivor_dashboard` | `p_league_id`, optional `p_week` | `Dashboard` | League member |
| `survivor_submit_pick` | `p_league_id`, `p_team_id`, optional `p_week` | `Dashboard` | League member |
| `survivor_delete_pick` | `p_league_id`, optional `p_week` | `Dashboard` | League member |
| `survivor_sync_schedule` | `p_snapshot` | Sync metadata | Server service role only |
| `survivor_claim_schedule_refresh` | optional `p_force` | `{ acquired, retryAfter }` | Server service role only |
| `survivor_fail_schedule_refresh` | none | `{ stale, retryAfter }` | Server service role only |
| `survivor_rate_limit` | `p_kind`, `p_key_hash` | `{ allowed, retryAfter }` | Server service role only |

Expected validation, membership, lock, and rate-limit failures return `{ error: { message, status, retryAfter? } }`. The API must translate this envelope to an appropriate HTTP error. Returning expected failures lets rejected-attempt counters persist. Unexpected database errors remain real PostgreSQL errors and roll back the transaction.

The authenticated user always comes from `auth.uid()`. Caller-provided account IDs, reveal times, clocks, standings, results, or administrator flags are not accepted. Public functions use fixed empty search paths and explicit privileges. Their helper functions are private and have no client execute grants.

## Setup and persistence

Supabase Auth owns password hashes, email verification, and user sessions. A trigger creates the private display-name profile when an Auth user is created. Existing Auth users receive profiles when the migration runs. SQLite passwords, accounts, sessions, and league data are **not** imported automatically; local development remains an independent database.

The schedule starts empty. The server's initial synchronization calls `survivor_sync_schedule` with the validated NFL snapshot using its secret/service-role key. It retains previous seasons so old standings do not disappear on rollover. No end-user API key can write games, scores, odds, or schedule metadata.

Each league supports up to 100 members and one entry per authenticated account. Entries and joins take row locks; picks also have unique week and unique used-team constraints. Earlier kickoff locks, New York Sunday reveal, no team reuse, missed picks, delayed results, and co-winners are evaluated in the database. No scheduled reveal job is needed: every dashboard read uses the database clock, and the browser refetches at the deadline.

The service-only rate limiter accepts fixed kinds `auth-register`, `auth-login`, `auth-reset`, and `auth-confirm`. Its key must be a 64-character SHA-256/HMAC digest created by the API, not a raw IP address. League creation, invite joining, and pick mutation have durable per-user limits inside their own RPCs, including rejected validation attempts.

## Local verification

See `docs/qa-plan.md` and the hosted SQL test suite for the tested PostgreSQL behavior. Tests may replace the private clock helper inside an isolated transaction to check exact boundaries. The production clock has no user-configurable override; it always returns PostgreSQL `clock_timestamp()`.

The schedule lease serializes refresh claims across serverless instances. It skips fresh snapshots for 30 minutes and holds an acquired lease for 60 seconds. Failed refreshes mark cached data stale and enforce a 60-second retry cooldown. A successful atomic sync clears the lease. The `p_force` option can bypass freshness only for a service-role caller; it cannot steal an active lease.
