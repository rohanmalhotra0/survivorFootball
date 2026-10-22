import { getHostedSchedule } from '../server/hosted/schedule.js';
try {
  const snapshot = await getHostedSchedule({ force: true, requirePersistence: true });
  if (!snapshot.games.length || snapshot.stale) throw new Error('No fresh hosted schedule was confirmed.');
  console.log(JSON.stringify({ season: snapshot.season, games: snapshot.games.length, week: snapshot.currentWeek, updatedAt: snapshot.updatedAt, source: snapshot.source }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Hosted schedule setup failed.');
  process.exitCode = 1;
}
