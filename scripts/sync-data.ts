import { syncSchedule } from '../server/data-provider.js';

const snapshot = await syncSchedule();
console.log(JSON.stringify({
  source: snapshot.source, season: snapshot.season, currentWeek: snapshot.currentWeek,
  games: snapshot.games.length, updatedAt: snapshot.updatedAt, stale: snapshot.stale,
}, null, 2));
if (snapshot.stale || snapshot.games.length === 0) process.exitCode = 1;
