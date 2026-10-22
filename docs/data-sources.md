# Schedule, results, and odds

The app uses real NFL schedule and completed-game results from **nflverse / nfldata**. It keeps a successful server-side snapshot and automatically refreshes at startup and every 30 minutes. This refresh interval is the app's polling cadence; it does not guarantee how frequently the upstream dataset changes.

- Dataset: <https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv>
- Maintainer: <https://github.com/nflverse/nfldata>
- Official field dictionary: <https://github.com/nflverse/nflreadr/blob/main/data-raw/dictionary_schedules.csv>
- Official reader confirming the dataset: <https://github.com/nflverse/nflreadr/blob/main/R/load_schedules.R>

Initial validation on October 22, 2026 retrieved 272 regular-season games for 2026 across all 18 weeks, including 14 Week 7 matchups. All 14 Week 7 games contained moneyline prices. The committed fallback in `server/fixtures/schedule.json` is an actual retrieved snapshot, not generated sample scores. Its timestamp records retrieval time. A restored fallback remains marked stale until a successful refresh. Runtime updates live in ignored `data/schedule.json`. Refreshes retain and update seasons already present in the cache so existing league results survive a season rollover. Back up this data directory together with the application database.

Run `npm run sync:data` to refresh immediately. A failed fetch retains the last good snapshot and makes the command exit nonzero; the UI reports stale data. Requests have a 15-second timeout. In the Codex cloud environment, `NODE_USE_ENV_PROXY=1` is required for Node's supported proxy route and is set by the package scripts. No API key is needed for nflverse.

## Time, results, and settlement

The source defines `gametime` as **Eastern local time regardless of stadium location**. The adapter converts with `America/New_York`, including daylight saving time. A Tuesday begins the next NFL week; a Monday game stays in its previous week. NFL season years continue through January/February of the following calendar year.

Both scores must be present to classify a game as final. A score of zero is valid; an empty score is never converted to zero. Ties have both scores and no winner. Source omissions or an unavailable network do not imply that a game was canceled or that a participant lost.

This feed is not a live play-by-play service. It does not reliably expose in-progress, canceled, or postponed states. The adapter therefore leaves games without final scores as scheduled instead of inventing a status. Kickoff time still governs pick locks. Missing scores remain pending for settlement. A production operator should reconcile unusual cancellation/postponement cases against official NFL decisions before applying a custom resolution.

## Odds meaning

`home_moneyline` and `away_moneyline` are American moneyline odds. The source does not identify a per-row bookmaker or quote time. The UI must call these **nflverse odds snapshots**, show retrieval time, and never represent them as guaranteed real-time sportsbook prices. A missing market remains unavailable.

For American odds `a`, market-implied probability is `-a / (-a + 100)` when negative, or `100 / (a + 100)` when positive. Zero is invalid. Probabilities include bookmaker margin and are not independent forecasts or guarantees. Survivor picks are straight-up winners; spreads and totals provide context and do not affect elimination.

The nflverse `spread_line` sign is unusual: a positive number means the home team is favored. The adapter negates it for conventional `homeSpread` display. For example, source `3` becomes home spread `-3`.

## Optional premium provider

A future licensed, bookmaker-attributed integration can use [The Odds API](https://the-odds-api.com/liveapi/guides/v4/):

`GET /v4/sports/americanfootball_nfl/odds?regions=us&markets=h2h,spreads&oddsFormat=american&dateFormat=iso`

This is **not configured in this build**. It requires a private server-side API key and access to `api.the-odds-api.com`. Store credentials securely; never put them in browser code or commit them. Match events by canonical teams and kickoff, retain bookmaker/market `last_update`, and honor quota headers. Official [Python samples](https://github.com/the-odds-api/samples-python) verify this endpoint pattern and document quota cost as number of regions multiplied by number of markets. The upcoming-events endpoint cannot supply arbitrary historical odds.

The current schedule/odds integration does not depend on ESPN's scoreboard or The Odds API. Their network destinations are included in the saved environment settings for research and possible future integration; enabling a domain does not configure a provider or supply an API key. Public access to data and image URLs does not establish a blanket license; consult the upstream terms before commercial redistribution.
