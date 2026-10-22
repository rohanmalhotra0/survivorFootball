import type { Dashboard } from './view-model';

export function getDemoDashboard(week = 7): Dashboard {
  const kickoff = '2026-10-25T17:00:00.000Z';
  const games = [
    ['12', '13', -260, 220, -6.5], ['2', '20', -185, 155, -3.5],
    ['21', '23', -210, 175, -4.5], ['9', '26', -140, 120, -2.5],
    ['25', '15', -155, 130, -3], ['1', '17', 125, -145, 2.5],
    ['8', '24', -120, 100, -1.5], ['10', '11', -190, 160, -4],
    ['6', '19', -165, 140, -3.5], ['16', '33', -200, 170, -4.5],
    ['27', '29', -175, 150, -3.5], ['4', '18', 110, -130, 2],
    ['28', '30', -150, 125, -3], ['22', '34', -220, 185, -5.5],
  ].map((g, i) => ({ id: `sample-${i}`, homeTeamId: String(g[0]), awayTeamId: String(g[1]), kickoff: i < 7 ? kickoff : '2026-10-25T20:25:00.000Z', status: 'scheduled', odds: { homeMoneyline: Number(g[2]), awayMoneyline: Number(g[3]), spread: Number(g[4]), source: 'Illustrative sample', updatedAt: '2026-10-22T13:30:00.000Z' } }));
  const picks = [
    { week: 1, teamId: '33', result: 'won' }, { week: 2, teamId: '28', result: 'won' },
    { week: 3, teamId: '4', result: 'won' }, { week: 4, teamId: '22', result: 'won' },
    { week: 5, teamId: '8', result: 'won' }, { week: 6, teamId: '25', result: 'won' },
  ];
  const names = ['You', 'Alex Morgan', 'Jordan Davis', 'Sam Wilson', 'Chris Lee', 'Taylor Brooks', 'Jamie Carter', 'Casey Smith', 'Morgan Reed', 'Riley James', 'Drew Parker', 'Avery Hill', 'Peyton Clarke', 'Logan Evans', 'Blake Ross', 'Quinn Walsh'];
  return {
    demo: true, user: null, league: { id: 'preview', name: 'The Sunday Club', season: 2026, inviteCode: 'PREVIEW', memberCount: 16 }, leagues: [],
    season: 2026, week, revealAt: kickoff, picksRevealed: false, games,
    members: names.map((name, i) => ({ id: `preview-${i}`, name, status: i < 12 ? 'active' : 'eliminated', weeksSurvived: i < 12 ? 6 : Math.max(1, 7 - i + 9), isYou: i === 0, pick: { hidden: true, submitted: i < 10 } })),
    myPicks: picks, myPick: null, usedTeamIds: picks.map(p => p.teamId), oddsUpdatedAt: '2026-10-22T13:30:00.000Z',
    dataSource: 'Interactive preview', dataWarning: 'Sample league, matchups and odds. Create an account to play with real NFL schedules.',
  };
}
