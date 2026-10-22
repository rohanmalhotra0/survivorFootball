# NFL roster and image provenance

The roster directory uses the **2026 nflverse roster release**, a public compilation of NFL player data. Team metadata and PNG logos come from nflverse's teams/colors/logos data. Roster status and affiliation are snapshots and can change after trades, signings, and releases.

The verified October 22, 2026 snapshot contains **3,053 roster records, 3,000 local player PNGs, and all 32 local team PNGs**. All **1,665 active players** have a local portrait. The remaining **53 records** are inactive, cut, retired, or other roster statuses without a usable source portrait. They display a labeled fallback. Each cached player image passed PNG signature validation; all 3,000 hashes were unique after excluding a known generic helmet image. This is asset coverage, not a claim that every player image is a current-season photograph.

- Roster: https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2026.csv
- Team metadata: https://raw.githubusercontent.com/nflverse/nflverse-pbp/master/teams_colors_logos.csv
- Team PNGs: https://github.com/nflverse/nflverse-pbp/tree/master/squared_logos
- Archived portrait PNGs: https://github.com/T1mSchneider/nfl_headshots/tree/098689222540770b195a7c0daf280df96779620c/headshots_png (pinned snapshot; historical uniforms may differ from current team affiliation)
- ESPN portraits: `https://a.espncdn.com/i/headshots/nfl/players/full/{espn_id}.png`
- NFL portrait fallback: the source `headshot_url`, with the supported `f_png` image format transformation.
- Official ESPN team roster enrichment: `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{teamId}/roster?season=2026`; matching full name and team resolves missing rookie portrait IDs without changing the stable directory ID.

## Refreshing

Run from the repository root with Node 24 or later:

```sh
NODE_USE_ENV_PROXY=1 node scripts/sync-rosters.ts --season=2026 --photos=all
```

`--photos=featured` fetches a prominent active player for each team, falling back to a quarterback if that player has moved or is inactive. `--photos=none` refreshes metadata and team logos while preserving any downloaded portraits. Existing valid local PNGs are reused. The pinned public portrait archive is checked before the ESPN and NFL source fallbacks. Name-based matches are skipped if the current roster contains multiple distinct players with that normalized name, except the individually verified portraits of Minnesota WR Justin Jefferson (ESPN ID 4262921) and Philadelphia WR DeVonta Smith (4241478). A known generic NFL helmet image is rejected by SHA-256 rather than counted as an athlete portrait. On machines without a proxy, `NODE_USE_ENV_PROXY=1` is harmless. The script preserves TLS verification, checks the PNG signature before writing files, writes downloads atomically, and limits simultaneous requests to eight.

`shared/players.ts` exports the actual roster and coverage metadata. `public/assets/players/manifest.json` records the refresh time, source, and number of locally available portraits. An external URL is retained where the download is unavailable; the UI must render the bundled generic silhouette if that URL also fails. The generic silhouette is explicitly a placeholder, not a claimed portrait. No player image is fabricated.

The sync requires access to `github.com`, `raw.githubusercontent.com`, `release-assets.githubusercontent.com`, `site.api.espn.com`, `a.espncdn.com`, and (for NFL fallbacks) `static.www.nfl.com`. A 403 from the environment proxy means the destination needs to be enabled; changing TLS checks or routing through a relay is not a remedy.

## Rights and attribution

NFL/team names, team logos, and player photographs remain the property of their respective rights holders. Availability from a public endpoint or open data repository does **not** grant a commercial image license. This project is an independent survivor-pool application, is not endorsed by Yahoo, ESPN, nflverse, the NFL, or its teams, and does not claim ownership of these marks or portraits. Obtain the appropriate image rights before public commercial distribution. Attribution and endpoint behavior do not establish licensing.
