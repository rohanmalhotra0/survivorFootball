# Survivor football research and implementation decisions

Research date: 2026-10-22.

## What was requested

A Yahoo-style NFL survivor experience: private leagues, account authentication, weekly team picks, a universal Sunday 1 p.m. Eastern reveal, weekly odds, and NFL player PNG imagery. The selected starting format is one entry per person in each private league, one team per week, no reuse, and elimination on one loss. The reveal follows `America/New_York` daylight saving time.

The implementation chooses and documents its own precise survivor rules in [RULES.md](RULES.md). It does not claim affiliation, copy Yahoo branding, or promise exact compatibility with Yahoo's current product.

## Verified official Yahoo sources

The environment initially blocked Yahoo with an egress-proxy 403. After the requested domain additions propagated, the following official pages were fetched successfully over HTTPS on 2026-10-22. Earlier candidate routes `/survival/help/rules` and `/survival/reg_rules` returned 404 and are not sources. The `/f1/reg_rules` page is standard fantasy football and is not evidence for survival rules.

| Official source | URL | Result |
| --- | --- | --- |
| Yahoo Survival Football landing page | https://football.fantasysports.yahoo.com/survival/ | HTTP 200 |
| How to play Yahoo Survival Football, SLN6555 | https://help.yahoo.com/kb/survival-football/play-yahoo-survival-football-sln6555.html | HTTP 200; core rule source |
| Select or edit your winning team, SLN6749 | https://help.yahoo.com/kb/survival-football/pick-teams-games-week-sln6749.html | HTTP 200; weekly pick workflow |
| Edit Private Group settings, SLN6559 | https://help.yahoo.com/kb/survival-football/edit-private-group-settings-survival-football-sln6559.html | HTTP 200; commissioner controls |
| One team per Pick'em or Survival group, SLN8440 | https://help.yahoo.com/kb/survival-football/team-pickem-survival-group-sln8440.html | HTTP 200; entry limit |

### Direct evidence

[Yahoo's landing page](https://football.fantasysports.yahoo.com/survival/) describes the core game as: “Pick one team to win each week.” It also advertises private groups with friends and optional strikes.

[Yahoo's how-to-play article, SLN6555](https://help.yahoo.com/kb/survival-football/play-yahoo-survival-football-sln6555.html), states:

> “If you forget to pick a team or the team that you picked loses or ties, you get a strike.”

> “Each team you pick is locked to you after that week, preventing you from picking them again for the rest of the regular season.”

> “By default, you'll have until 10 a.m. PT to make your pick.”

> “If the last group of active players all get eliminated or all make it to the end at the same time, they're all declared winners.”

The same article describes public groups with one strike, private groups configurable to two strikes, two-pick weeks for public groups in weeks 14–18 and optional private-group two-pick weeks in weeks 9–18, private groups of up to 100 members, and an optional playoff phase that resets used teams. Joining/leaving closes after a group's first deadline.

[Yahoo's selection article, SLN6749](https://help.yahoo.com/kb/survival-football/pick-teams-games-week-sln6749.html), states:

> “While you can't make picks for future weeks, selections for next week can begin starting Tuesday and be edited until your weekly deadline, usually Sunday at 10 a.m. PT.”

[Yahoo's entry article, SLN8440](https://help.yahoo.com/kb/survival-football/team-pickem-survival-group-sln8440.html), states:

> “Managers can only create one team (pick set) per Yahoo ID in a private group”

[Yahoo's commissioner article, SLN6559](https://help.yahoo.com/kb/survival-football/edit-private-group-settings-survival-football-sln6559.html), documents settings changes, member lockouts, and group resets through commissioner tools. Those capabilities should not be inferred to exist in this application merely because Yahoo has them.

### Yahoo comparison and deliberate scope

| Topic | Verified Yahoo behavior | This application's behavior |
| --- | --- | --- |
| Core selection | Choose NFL teams to win, rather than draft a scoring roster | Same core game; player imagery is context |
| Team reuse | No repeat team during the regular season | No repeat team per entry and league |
| Losing, tying, missing pick | Each gives a strike; public limit one, private optionally two | User-selected classic one-strike elimination |
| Number of picks | One initially; configurable two-pick weeks later | User-selected one pick every week |
| Weekly deadline | Default Sunday 10 a.m. Pacific; private groups can use five minutes before the first game | Sunday 13:00 America/New_York, plus each selected game's earlier actual kickoff |
| Opponent reveal | Not established by the pages retrieved | User-required simultaneous Sunday 13:00 reveal, enforced in API |
| Entry count | One pick set per Yahoo ID in a private group | One entry per account in each private league |
| Group type and size | Public and private; private up to 100 | User-selected private invite-only leagues; up to 100 members |
| All final surviving entries lose together | All are winners | Final active group becomes co-winners once earlier unresolved results settle |
| Multiple entries survive the final week | All are winners | Surviving week-18 entries are co-winners |
| Season | Optional postseason, with used-team reset | Regular season only, 18 weeks |
| Commissioner tools | Includes member lockout/group reset/configurable rules | Fixed user-selected rules and private league creation/invites; no claim of full Yahoo tool parity |

The fetched pages did not establish Yahoo's precise handling of canceled/postponed games, early-game reveal visibility, or every kickoff-lock exception. This app documents its own rules for those cases rather than attributing them to Yahoo. Current primary-source verification now supports the shared survivor mechanics; it does not establish a byte-for-byte or feature-for-feature Yahoo clone.

## Product decisions made explicitly

1. **Team selection, not player drafting.** Survivor pools choose teams to win their NFL game. Player portraits are additional team context and browsing content.
2. **One universal reveal with earlier locks.** Each pick locks at the earlier of its game's kickoff or Sunday 1 p.m. New York time. An early game's result must not permit a player to change to another team before Sunday.
3. **Server-enforced secrecy.** Hiding CSS or omitting a column does not protect a pick. API responses must redact competitors' unrevealed selection, pick history, and result-derived status. League aggregates must use revealed weeks only.
4. **Classic elimination.** Losses, ties, and missing picks eliminate. The app states the treatment of ties rather than assuming users will infer it.
5. **No reuse is per league entry.** A user's entries in different private leagues are independent.
6. **Cancellation and postponement differ.** A canceled selection becomes void, preserving survival but consuming the selected team. A postponement remains pending. Neither situation invents a winner or a score.
7. **Settled champions only.** The last remaining entry in a multi-member league wins only after its decisive pick and all its earlier picks settle as surviving. Multiple week-18 survivors become co-winners. In a multi-member league, the final active group all losing together also become co-winners, following verified Yahoo rules; any earlier pending results must settle first. A solo league is explicitly a practice run through week 18, ending without a champion on an earlier elimination. No Yahoo solo exception was established by retrieved sources. All winner decisions use revealed weeks.
8. **Odds are informational snapshots.** Source, availability, demonstration status, and timestamps matter. A moneyline-derived percentage is labeled implied probability, not a certainty or unsupported predictive model.

## Security and correctness checks to preserve

- Reveal boundaries immediately before and at Sunday 13:00 in both EST and EDT, including DST transition weeks.
- A Thursday pick remains hidden to opponents after the game ends and cannot be replaced after kickoff.
- A Monday selection cannot be submitted after the common Sunday deadline.
- Opponent status, wins, survived-week counts, pick history, league totals, and activity must not reveal early outcomes before reveal.
- The authenticated session determines who can write a pick; body/query user IDs cannot impersonate a member.
- Private-league membership is required for reads and writes. A commissioner has no hidden-pick bypass.
- A team cannot be reused within the same entry. Concurrent requests must not bypass this constraint.
- A tie, no pick, void game, postponed game, and repeated result update each have an explicit stable outcome.
- Demo odds and player metadata must not be represented as current live NFL data.

## Verified schedule and odds sources

These read-only HTTPS sources were fetched successfully by the data-research agent:

- [nflverse / nfldata schedule and final results CSV](https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv)
- [nflreadr official schedule loader](https://raw.githubusercontent.com/nflverse/nflreadr/main/R/load_schedules.R), which identifies the nfldata feed
- [nflreadr schedule field dictionary](https://raw.githubusercontent.com/nflverse/nflreadr/main/data-raw/dictionary_schedules.csv)

The inspected feed contained 272 regular-season games for 2026, weeks 1–18. Week 7 contained 14 games and 14 pairs of American moneylines. That is evidence about the retrieved snapshot, not a guarantee of future price completeness. Kickoff dates and times are Eastern local time and need DST-aware conversion. Missing score fields must remain unknown; a legitimate score of zero is not missing.

The integration retrieves the schedule and final-result snapshot on startup and on its configured polling interval. It preserves the last good snapshot after a network or schema failure and exposes its freshness. Polling frequency is not a promise about how often nflverse updates its source.

nflverse does not supply a reliable bookmaker identity or per-quote timestamp in these rows. The app labels prices **nflverse odds snapshot** and records retrieval time; it must not call them live sportsbook prices. Its current schedule adapter represents scheduled games and final scores, not live play-by-play, and does not reliably classify postponed or canceled games. Unknown results stay pending. The domain can handle an explicit postponed/canceled status from a future richer integration.

The official [The Odds API Python examples](https://raw.githubusercontent.com/the-odds-api/samples-python/master/odds.py) were also reachable and provide a possible future licensed provider integration. The provider's documentation site and API hostname were blocked during the initial research and were not revalidated after later networking changes. The current app does not claim this integration is enabled or that credentials are present.

## Player imagery

See [asset provenance](assets.md) for downloaded player PNGs, source, coverage, and refresh behavior. Availability of a third-party URL does not itself establish redistribution rights, current roster status, or that a public endpoint is a supported production API. Production operators should confirm provider terms and image rights before public commercial deployment.

## Reveal implementation spot checks

Direct execution of the domain calendar functions returned the expected Sunday boundary for:

| Season/week | Sunday reveal in UTC | New York time |
| --- | --- | --- |
| 2026 week 7 | 2026-10-25 17:00 UTC | 13:00 EDT |
| 2026 week 8 | 2026-11-01 18:00 UTC | 13:00 EST, after DST ends |
| 2026 week 9 | 2026-11-08 18:00 UTC | 13:00 EST |
| 2026 week 18 | 2027-01-10 18:00 UTC | 13:00 EST |

Each check remained hidden one millisecond before the boundary and revealed exactly at it. Broader API and browser verification belongs to the test suite and [QA plan](qa-plan.md); these spot checks alone do not establish every application path is correct.

## Final backend review

The result calculation evaluates only weeks whose reveal has passed. A survivor with a pending pick cannot become champion before that result settles. Private member/pick routes require authenticated league membership, and writes use the session user rather than a supplied user ID. Already eliminated entries and champions are rejected when they attempt another pick. Earlier selected-game locks are checked before replacement or deletion, so choosing a later unstarted team cannot replace a Thursday pick after kickoff.

Historical pick browsing uses the same server-time reveal checks. It displays the latest resolved member standing beside the selected week's picks; it is not a reconstruction of standings as they were on that historical date. Retained schedule seasons are required to preserve historical result resolution after rollover.
