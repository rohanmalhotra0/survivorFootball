/** Refresh public NFL metadata and source-backed portraits; never manufactures players or odds. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const yearArg = process.argv.find((value) => value.startsWith('--season='))?.split('=')[1];
const now = new Date();
const season = Number(yearArg ?? (now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()));
if (!Number.isInteger(season) || season < 2000 || season > 2100) throw new Error('Invalid --season=YYYY');
const photos = process.argv.find((value) => value.startsWith('--photos='))?.split('=')[1] ?? 'all';
if (!['all', 'featured', 'none'].includes(photos)) throw new Error('Use --photos=all, featured, or none');

const TEAM_IDS: Record<string, string> = {ARI:'22',ATL:'1',BAL:'33',BUF:'2',CAR:'29',CHI:'3',CIN:'4',CLE:'5',DAL:'6',DEN:'7',DET:'8',GB:'9',HOU:'34',IND:'11',JAX:'30',KC:'12',LAC:'24',LAR:'14',LV:'13',MIA:'15',MIN:'16',NE:'17',NO:'18',NYG:'19',NYJ:'20',PHI:'21',PIT:'23',SF:'25',SEA:'26',TB:'27',TEN:'10',WAS:'28'};
const TEAM_SOURCE = 'https://raw.githubusercontent.com/nflverse/nflverse-pbp/master/teams_colors_logos.csv';
const ROSTER_SOURCE = `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${season}.csv`;
const ESPN = 'https://a.espncdn.com/i/headshots/nfl/players/full/';
// An existing public archive is pinned so a refresh cannot silently change archived portraits.
// Its photos can show historical uniforms. Current team affiliation always comes from the roster.
const PORTRAIT_ARCHIVE = 'https://raw.githubusercontent.com/T1mSchneider/nfl_headshots/098689222540770b195a7c0daf280df96779620c/headshots_png/';

function parseCsv(input: string): Record<string, string>[] {
  const records: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if (char === '\n' && !quoted) { row.push(field.replace(/\r$/, '')); records.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); records.push(row); }
  const headers = records.shift()!;
  return records.filter((record) => record.length === headers.length).map((record) => Object.fromEntries(headers.map((header, i) => [header, record[i]])));
}

async function get(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'SurvivorClub/1.0 (NFL roster sync)' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response;
}

const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
// This archive asset is a generic NFL helmet, not the named athlete's portrait.
const GENERIC_PORTRAIT_HASH = '349f37471b01b21f2a94039ca344b64b5a0e633dd10e4e9dfe551acb7d674999';
function isPortrait(bytes: Buffer) { return bytes.length > 100 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && createHash('sha256').update(bytes).digest('hex') !== GENERIC_PORTRAIT_HASH; }
async function exists(path: string) { try { return isPortrait(await readFile(path)); } catch { return false; } }
async function downloadPng(url: string, path: string) {
  if (await exists(path)) return true;
  try {
    const bytes = Buffer.from(await (await get(url)).arrayBuffer());
    if (!isPortrait(bytes)) return false;
    await writeFile(`${path}.tmp`, bytes); await rename(`${path}.tmp`, path); return true;
  } catch { return false; }
}
async function pool<T>(items: T[], handler: (item: T) => Promise<void>, concurrency = 8) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await handler(items[next++]);
  }));
}

const [teamRows, rosterRows] = await Promise.all([get(TEAM_SOURCE).then((r) => r.text()).then(parseCsv), get(ROSTER_SOURCE).then((r) => r.text()).then(parseCsv)]);
await Promise.all(['shared','public/assets/teams','public/assets/players'].map((dir) => mkdir(resolve(ROOT, dir), { recursive: true })));
const teams = teamRows.filter((row) => TEAM_IDS[row.team_abbr]).map((row) => ({
  id: TEAM_IDS[row.team_abbr], abbreviation: row.team_abbr, name: row.team_name,
  city: row.team_name.slice(0, -(row.team_nick.length + 1)), color: row.team_color,
  logo: `/assets/teams/${row.team_abbr}.png`, conference: row.team_conf, division: row.team_division,
}));
await pool(teams, async (team) => {
  const ok = await downloadPng(`https://raw.githubusercontent.com/nflverse/nflverse-pbp/master/squared_logos/${team.abbreviation}.png`, resolve(ROOT, `public${team.logo}`));
  if (!ok) throw new Error(`Could not obtain verified PNG logo for ${team.abbreviation}`);
});
if (teams.length !== 32) throw new Error(`Expected 32 NFL teams, got ${teams.length}`);

// A roster release contains current team affiliation and status, not a fictional fantasy draft.
const unique = new Map<string, Record<string, string>>();
for (const row of rosterRows) {
  const abbreviation = row.team === 'LA' ? 'LAR' : row.team;
  if (!TEAM_IDS[abbreviation] || !row.full_name) continue;
  const id = row.espn_id || row.gsis_id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) continue;
  unique.set(id, { ...row, abbreviation, id });
}
const rawPlayers = [...unique.values()];
function portraitSlug(name: string) { return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
let officialRosterMatches = 0;
if (photos !== 'none') {
  // The release may not yet know a rookie's ESPN ID. Match the official team roster by
  // normalized full name AND team, retaining the stable source ID in our exported directory.
  await pool(teams, async (team) => {
    const candidates = rawPlayers.filter((player) => TEAM_IDS[player.abbreviation] === team.id);
    if (!(await Promise.all(candidates.map((player) => exists(resolve(ROOT, `public/assets/players/${player.id}.png`))))).some((present) => !present)) return;
    try {
      const response = await get(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${team.id}/roster?season=${season}`);
      const data = await response.json() as { athletes?: Array<{ items?: Array<{ id?: string; displayName?: string; headshot?: { href?: string } }> }> };
      const athletes = (data.athletes ?? []).flatMap((group) => group.items ?? []);
      for (const row of candidates) {
        const matches = athletes.filter((athlete) => athlete.displayName && portraitSlug(athlete.displayName) === portraitSlug(row.full_name));
        if (matches.length === 1 && matches[0].headshot?.href?.startsWith(ESPN)) {
          row.official_headshot = matches[0].headshot.href;
          officialRosterMatches++;
        }
      }
    } catch { /* Offline builds retain source-backed metadata and existing downloaded portraits. */ }
  }, 4);
}
const nameCounts = new Map<string, number>();
for (const player of rawPlayers) { const slug = portraitSlug(player.full_name); nameCounts.set(slug, (nameCounts.get(slug) ?? 0) + 1); }
const STAR_NAMES: Record<string, string> = {
  ARI:'Kyler Murray',ATL:'Michael Penix Jr.',BAL:'Lamar Jackson',BUF:'Josh Allen',CAR:'Bryce Young',CHI:'Caleb Williams',
  CIN:'Joe Burrow',CLE:'Myles Garrett',DAL:'Dak Prescott',DEN:'Bo Nix',DET:'Jared Goff',GB:'Jordan Love',HOU:'C.J. Stroud',
  IND:'Jonathan Taylor',JAX:'Trevor Lawrence',KC:'Patrick Mahomes',LAC:'Justin Herbert',LAR:'Matthew Stafford',LV:'Brock Bowers',
  MIA:'Tua Tagovailoa',MIN:'Justin Jefferson',NE:'Drake Maye',NO:'Alvin Kamara',NYG:'Malik Nabers',NYJ:'Garrett Wilson',
  PHI:'Jalen Hurts',PIT:'T.J. Watt',SEA:'Jaxon Smith-Njigba',SF:'Brock Purdy',TB:'Baker Mayfield',TEN:'Cam Ward',WAS:'Jayden Daniels',
};
const featuredIds = new Set<string>();
for (const team of teams) {
  const candidates = rawPlayers.filter((player) => TEAM_IDS[player.abbreviation] === team.id && player.status === 'ACT');
  const qb = candidates.find((player) => player.full_name === STAR_NAMES[team.abbreviation])
    ?? candidates.filter((player) => player.position === 'QB').sort((a,b) => Number(b.years_exp) - Number(a.years_exp))[0]
    ?? candidates[0];
  if (qb) featuredIds.add(qb.id);
}
let downloaded = 0; let unavailable = 0;
const players: Array<{id:string;name:string;position:string;teamId:string;jersey:string;headshot:string;status:string;featured:boolean}> = [];
await pool(rawPlayers, async (row) => {
  const local = `/assets/players/${row.id}.png`;
  const target = resolve(ROOT, `public${local}`);
  let present = await exists(target);
  if (!present && photos !== 'none' && (photos === 'all' || featuredIds.has(row.id))) {
    // Do not guess by name where the current roster has two different people with that name.
    // These two WRs have manually verified portraits; their same-name counterparts do not.
    const slug = portraitSlug(row.full_name);
    if (nameCounts.get(slug) === 1 || ['4262921', '4241478'].includes(row.id)) {
      present = await downloadPng(`${PORTRAIT_ARCHIVE}${slug}.png`, target);
    }
    if (!present && row.official_headshot) present = await downloadPng(row.official_headshot, target);
    if (!present && row.espn_id) present = await downloadPng(`${ESPN}${row.espn_id}.png`, target);
    if (!present && row.headshot_url) present = await downloadPng(row.headshot_url.replace('f_auto,q_auto', 'f_png,q_auto,w_400'), target);
  }
  if (present) downloaded++; else unavailable++;
  players.push({ id: row.id, name: row.full_name, position: row.position, teamId: TEAM_IDS[row.abbreviation], jersey: row.jersey_number, headshot: present ? local : row.official_headshot || (row.espn_id ? `${ESPN}${row.espn_id}.png` : '/assets/players/unavailable.svg'), status: row.status, featured: featuredIds.has(row.id) });
});
players.sort((a,b) => a.name.localeCompare(b.name));
const syncedAt = new Date().toISOString();
const activePlayers = players.filter((player) => player.status === 'ACT');
const activeLocalPngs = activePlayers.filter((player) => player.headshot.endsWith('.png') && player.headshot.startsWith('/assets/players/')).length;
const metadata = { season, syncedAt, rosterSource: ROSTER_SOURCE, teamSource: TEAM_SOURCE, portraitArchive: PORTRAIT_ARCHIVE, totalPlayers: players.length, localPngs: downloaded, remoteOrUnavailable: unavailable, activePlayers: activePlayers.length, activeLocalPngs, activeMissing: activePlayers.length - activeLocalPngs, officialRosterMatches, requestedPhotos: photos };
const header = '// Generated by scripts/sync-rosters.ts from nflverse. See docs/assets.md for provenance and image rights.\n';
await writeFile(resolve(ROOT, 'shared/nfl.ts'), `${header}export interface NFLTeam { id: string; abbreviation: string; name: string; city: string; color: string; logo: string; conference: string; division: string }\nexport const NFL_TEAMS: NFLTeam[] = ${JSON.stringify(teams, null, 2)};\n`);
await writeFile(resolve(ROOT, 'shared/players.ts'), `${header}export interface NFLPlayer { id: string; name: string; position: string; teamId: string; jersey: string; headshot: string; status: string; featured: boolean }\nexport const ROSTER_UPDATED_AT = ${JSON.stringify(syncedAt)};\nexport const ROSTER_SEASON = ${season};\nexport const ROSTER_ASSET_STATUS = ${JSON.stringify(metadata, null, 2)};\nexport const NFL_PLAYERS: NFLPlayer[] = ${JSON.stringify(players)};\n`);
await writeFile(resolve(ROOT, 'public/assets/players/manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata, null, 2));
if (unavailable && photos !== 'none') console.warn(`${unavailable} players have no locally cached PNG. The UI must fall back when an upstream portrait is unavailable.`);
