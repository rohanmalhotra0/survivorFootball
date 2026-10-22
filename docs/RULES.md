# Survivor Club: league rules

This is a private NFL survivor game. It uses the classic survivor format with the explicit rules below; it is not affiliated with Yahoo, the NFL, or a sportsbook.

## Joining and making picks

- Create an account with email and password, then create a private league or join with its invite code.
- Each person has one entry per league, with up to 100 members in a private league. Join before the league's opening week's Sunday deadline; a late join cannot receive credit for already completed weeks.
- Choose one NFL **team** each week. Player portraits are presentation and reference material, not a fantasy roster or player-scoring system.
- A team can be used only once per entry in a season. A team used in one league is still available in a separate league.
- An outright win keeps the entry alive. A loss or tie eliminates the entry. Missing the weekly pick deadline also eliminates the entry.
- A pick may be changed while both its selected game and the weekly pick window are still open. Once an early-game pick locks, it cannot be replaced with a team whose game has not started.

## The Sunday reveal

Every week's common deadline and reveal is **Sunday at 1:00 p.m. America/New_York**, following daylight saving time. This is 17:00 UTC during EDT and 18:00 UTC during EST; it is not fixed EST year-round.

A selected team's game may begin sooner, including Thursday, Saturday, or a Sunday international game. That pick locks at the game's kickoff. Otherwise, all picks lock at the Sunday deadline, including picks for late Sunday and Monday games.

Until Sunday at 1:00 p.m., you can see your own pick, but other league members cannot see it. A commissioner cannot see hidden selections either. The server hides competitors' team selections and pick history for the unrevealed week. Public standings and survival counts also exclude unrevealed results so an early game cannot reveal a hidden pick indirectly. Your own pick can show the outcome of your known early game, while league standings wait for the reveal.

At the reveal, league members can see that week's selections together. Client clocks and countdowns do not decide eligibility or visibility; the server does.

## Results and unusual games

- A game remains pending until the data source reports it final. The game must have a final score before a winner is assigned.
- A tie counts as an elimination under classic rules.
- A postponed game stays pending until a final or canceled result is available. A postponement alone does not eliminate an entry.
- If a data provider explicitly marks a game canceled, its pick becomes **void**. That entry survives that week, and the selected team remains used for the season. The entry does not receive a game win for a void pick. The current nflverse integration supplies scheduled games and final scores; it does not reliably distinguish a cancellation from missing results, so such a game remains pending until a richer provider/status update supplies that fact.
- Completed results can be refreshed repeatedly without adding duplicate wins or applying a second elimination.

## Winning the league

A league with at least two members ends when exactly one entry remains and that entry has a settled winning or void pick for the decisive week, with no earlier unresolved selection. That entry is the champion. A still-pending surviving game does not produce an early winner. Winner announcements use only revealed weeks, so a Thursday result cannot disclose a selection before Sunday.

If multiple entries survive through week 18 with all their selections settled, they are co-winners. Winning entries cannot submit further picks after the league ends.

If the final active group in a multi-member league all lose, tie, or miss a pick in the same week, those final active entries become **co-winners**, matching Yahoo's no-tiebreaker rule. Earlier unresolved games must settle before that award is final, because an earlier loss could change who belonged to the last active group. Each week's actual pick result remains visible; a co-winner designation does not rewrite a loss as a win.

A one-member league is solo practice. It continues through week 18 rather than awarding an immediate championship. An early elimination ends that practice run without a champion; a solo entry that survives the full regular season wins. This solo-practice behavior is an explicit application rule, not a separately verified Yahoo rule.

When viewing an earlier week's picks, the member status represents the league's latest resolved standing, not a historical standings snapshot.

## Odds and refreshes

Odds provide context for a team selection; making a survivor pick does not place a wager. Prices are snapshots, can move, and do not guarantee an outcome. Use each card's data mode and update timestamp to distinguish a live provider response from demonstration data. Missing or unavailable prices are not zero odds.

When moneyline prices are available, displayed implied probabilities come from those prices and may include bookmaker margin. Positive American odds `+A` imply `100 / (A + 100)`; negative odds `-A` imply `A / (A + 100)`. A probability is not a prediction certainty.

## Operational boundaries

The regular season has 18 weeks. A league's season and week come from the configured football schedule; the app does not assume that calendar-week numbers are football-week numbers. Demonstration data is for exploration and testing and must remain visibly identified. Provider outages should preserve an existing snapshot with its age rather than inventing a current score or price.

These rules describe this application's selected game format. Consult [the research notes](RESEARCH.md) for sources, access limitations, and distinctions from independently verified Yahoo behavior.
