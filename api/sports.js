// api/sports.js — Football fixtures from API-Sports (v3.football.api-sports.io)
// Fetches yesterday + today + tomorrow to handle timezones and recently played games
const BASE = 'https://v3.football.api-sports.io';

const LEAGUE_IDS = [39, 2, 71, 13, 135, 9, 140, 10];

// Team IDs for specific clubs/nationals to always include
const TEAM_IDS = [
  121, // Palmeiras
  529, // Barcelona
  541, // Real Madrid
  6,   // Brazil national
  27,  // Portugal national
  26,  // Argentina national
];

// Status short codes → normalised status
const LIVE_CODES    = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE']);
const FINISHED_CODES = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);
const PST_CODES      = new Set(['PST', 'CANC', 'ABD', 'SUSP', 'INT']);

function parseStatus(fixture) {
  const s = fixture.fixture?.status?.short || 'NS';
  if (LIVE_CODES.has(s))     return { status: 'live',       elapsed: fixture.fixture.status.elapsed ?? null };
  if (FINISHED_CODES.has(s)) return { status: 'finished',   elapsed: null };
  if (PST_CODES.has(s))      return { status: 'postponed',  elapsed: null };
  return                            { status: 'upcoming',   elapsed: null };
}

function formatKickoff(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleTimeString('de-DE', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
    });
  } catch { return ''; }
}

function isoDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

async function fetchFixtures(params, apiKey) {
  const qs = new URLSearchParams(params);
  try {
    const res = await fetch(`${BASE}/fixtures?${qs}`, {
      headers: { 'x-apisports-key': apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.response) ? data.response : [];
  } catch {
    return [];
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache for 10 min — balances live-score freshness with API quota
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');

  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) {
    return res.status(200).json({ fixtures: [], date: null, keyMissing: true });
  }

  const yesterday = isoDate(-1);
  const today     = isoDate(0);
  const tomorrow  = isoDate(1);
  const dates = [yesterday, today, tomorrow];

  // Fetch all leagues + team-specific fixtures across 3 days in parallel
  const allSettled = await Promise.allSettled([
    ...dates.flatMap(date => LEAGUE_IDS.map(id => fetchFixtures({ date, league: id }, apiKey))),
    ...dates.flatMap(date => TEAM_IDS.map(id  => fetchFixtures({ date, team: id  }, apiKey))),
  ]);

  const raw = allSettled.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // Deduplicate by fixture id
  const seen = new Set();
  const unique = raw.filter(f => {
    const id = f.fixture?.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const fixtures = unique.map(f => {
    const { status, elapsed } = parseStatus(f);
    const kickoffRaw = f.fixture?.date || null;
    // Determine which day bucket this fixture belongs to
    const fixtureDate = kickoffRaw ? kickoffRaw.split('T')[0] : today;
    let dayLabel = 'Today';
    if (fixtureDate === yesterday) dayLabel = 'Yesterday';
    else if (fixtureDate === tomorrow) dayLabel = 'Tomorrow';

    return {
      id:          `fixture-${f.fixture.id}`,
      type:        'fixture',
      topic:       'sports',
      league:      f.league?.name  || '',
      leagueLogo:  f.league?.logo  || null,
      homeTeam:    f.teams?.home?.name || '',
      homeLogo:    f.teams?.home?.logo || null,
      awayTeam:    f.teams?.away?.name || '',
      awayLogo:    f.teams?.away?.logo || null,
      homeScore:   f.goals?.home ?? null,
      awayScore:   f.goals?.away ?? null,
      status,
      elapsed,
      kickoff:     formatKickoff(kickoffRaw),
      kickoffRaw,
      dayLabel,
    };
  });

  // Sort: live → upcoming (chronological) → postponed → finished; within same status sort by date
  const ORDER = { live: 0, upcoming: 1, postponed: 2, finished: 3 };
  fixtures.sort((a, b) => {
    const d = (ORDER[a.status] ?? 4) - (ORDER[b.status] ?? 4);
    if (d !== 0) return d;
    if (a.kickoffRaw && b.kickoffRaw) return new Date(a.kickoffRaw) - new Date(b.kickoffRaw);
    return 0;
  });

  return res.status(200).json({ fixtures, date: today });
};
