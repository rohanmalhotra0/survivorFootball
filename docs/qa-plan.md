# Survivor readiness checks

The product uses a private invite league, one NFL team per week, no repeat teams, and elimination after one losing or tied result. All league picks remain private until Sunday at 1 p.m. America/New_York, including weeks that cross daylight saving time. Picks additionally lock when their selected game kicks off.

## Required automated checks

- Registration, sign-in, sign-out and persistent session authentication work. Password hashes and session tokens never appear in API bodies. Session cookies use HttpOnly and SameSite protections.
- Unauthenticated requests cannot read a private league. Authenticated outsiders cannot access league data or submit picks. Invite codes grant membership without granting ownership.
- Competitor picks, team identities, and historical selections remain redacted before their reveal timestamp. The submitting user can see their own selection. Every league/dashboard route uses the same rule.
- Immediately before the deadline, another user's pick is hidden; exactly at the deadline it is visible. Before/after daylight saving time the UTC reveal shifts while New York's wall clock remains 13:00.
- Valid picks persist. Picks for teams outside the week's games, repeated teams, eliminated members, expired weeks, and games already in progress are rejected.
- Replacing or deleting a pick is permitted only while the original and replacement picks remain eligible. A Thursday pick cannot be moved after its Thursday kickoff.
- Deadline processing marks missing picks eliminated. Final win survives; final loss or tie eliminates; postponed/canceled/unplayed games do not invent a win or a loss. Settlement is repeatable.
- Mutation routes reject cross-origin browser requests. Validation rejects malformed emails, short passwords, malformed input and duplicate membership.
- Odds and schedule metadata distinguish real upstream values from unavailable/stale data. American-odds implied probabilities are computed correctly and described as market estimates rather than guarantees.

## Browser smoke checks

- Dashboard loads on desktop and narrow mobile widths without horizontal overflow or runtime exceptions.
- Demo access is explicitly labeled and does not masquerade as real shared league state.
- Email authentication, create/join flows, team selection and save/error feedback are usable through visible controls.
- Navigation, week selection, rules/help, player search and sign-out work by keyboard and pointer. Dialogs have labels and useful focus behavior.
- Team/player images provide a graceful fallback when a portrait is unavailable.

Tests use temporary SQLite databases and deterministic clocks/schedules. No tests contact production services or require real user credentials.

## Verified run

On 2026-10-22, the complete native suite passed **38 tests** with no skips. Chromium against the production bundle passed **7 browser scenarios**, including:

- Registration, wrong-password feedback, sign-in, sign-out, two-league switching, and persisted picks after reload.
- A second user's invite join, with the first user's choice still absent from the API before reveal.
- Keyboard dialog trapping and restored opener focus.
- A simulated reveal boundary that triggers a server refetch while retaining secrecy when the server still returns hidden picks.
- Responsive layouts at 320, 390 and 768 pixels, with no document overflow or overlapping strategy text.

The final active group becoming co-winners after simultaneous elimination is covered separately, including exclusions for members eliminated in earlier weeks and unresolved earlier games that delay championship settlement. Losing game outcomes remain losses in history even when the league rule awards co-winner status.

Commands:

```sh
npm test
# With the application already running:
TEST_BASE_URL=http://127.0.0.1:3100 npx playwright test
```

The browser run used its own temporary SQLite database, leaving the development database untouched. Local review captures are `artifacts/dashboard-desktop.png`, `artifacts/dashboard-mobile.png`, and `artifacts/dashboard-tablet.png`.

Final startup validation also confirmed nonzero failure on an occupied port, development HMR sharing the application port without collisions, and concurrent cache writes from six separate processes. Two simultaneous live feed refreshes completed with fresh, valid cache data.
