# Pulse — Project Context for Claude Code Sessions

## What is Pulse
A personal PWA news feed app hosted on Vercel. Single HTML file SPA + Vercel serverless API functions. No build step, no framework. Deploy = git push.

**Live branch:** `claude/pulse-news-feed-app-iS1fZ`
**Deploy:** Push to this branch → Vercel auto-deploys.

---

## Tech Stack

| Layer | Details |
|---|---|
| Frontend | Single `index.html` — vanilla JS, CSS custom properties, IndexedDB |
| API | Vercel serverless functions (`api/*.js`), Node 18, CommonJS |
| RSS | `rss-parser`, Google News RSS (EN + optional PT) |
| Article extraction | `@mozilla/readability` + `jsdom` |
| AI | Anthropic `claude-haiku-4-5-20251001` — single-call summarization |
| Sports data | `v3.football.api-sports.io` (env: `FOOTBALL_API_KEY`) |
| Videos | YouTube Data API v3 (env: `YOUTUBE_API_KEY`) |
| PWA | `sw.js` service worker (`pulse-v2` cache), `manifest.json` |

**Environment variables required on Vercel:**
- `ANTHROPIC_API_KEY`
- `FOOTBALL_API_KEY`
- `YOUTUBE_API_KEY`

---

## File Map

```
index.html          — full SPA (≈2800 lines), all UI + JS
api/feed.js         — main feed: RSS fetch, article scrape, Claude summarise
api/sports.js       — football fixtures from API-Sports
api/ask.js          — Ask the Feed: POST {question, context} → Claude answer
api/digest.js       — Weekly digest: POST {savedHeadlines, savedIntents, noteTexts} → Claude paragraph
api/mindset.js      — Living summary: POST {notes} → Claude 2-3 sentences (2nd person)
api/connections.js  — Weekly note↔headline connections: POST {notes, headlines} → Claude
sw.js               — Service worker (cache name: pulse-v2)
manifest.json       — PWA manifest
vercel.json         — maxDuration per function, CORS headers (GET+POST+OPTIONS)
```

---

## IndexedDB Schema

```
DB_NAME = 'pulse-db', DB_VER = 3
Stores:
  saved      — keyPath: 'id'  — saved cards {id, headline, summary, link, topic, saveTag, note, ...}
  notes      — keyPath: 'id'  — quick notes {id, text, ts, isDigest?}
  signals    — keyPath: 'id'  — behaviour signals {id, type:'save'|'read', topic, intent, ts}
  settings   — keyPath: 'key' — persisted settings:
      reading_style     → 'direct'|'narrative'|'analytical'|'casual'
      interest_brief    → free-text string
      mindset_summary   → cached mindset text
      mindset_note_count → int
      last_connection_date → ISO date
      custom_topics     → comma-separated topic list
      show_pt           → '1'|'0'
      last_digest_date  → YYYY-MM-DD
```

---

## Tabs & Pages (current)

| Tab | data-tab | Page div | Rendered by |
|---|---|---|---|
| Feed | `feed` | `#feed-page` | `renderFeedPage()` |
| Sports | `sports` | `#sports-page` | `renderSportsPage()` |
| Saved | `saved` | `#saved-page` | `renderSavedPage()` |
| Later | `read-later` | `#read-later-page` | `renderReadLaterPage()` |
| Notes | `notes` | `#notes-page` | `renderNotesPage()` |

---

## All Implemented Features (as of last session)

### Feed Tab
- **Carta do Momento** — Claude editorial brief at top, truncated to 3 sentences with "Read more"
- **Trending strip** — horizontal keyword chips from today's headlines (client-side word freq); tap → opens search
- **Ask the feed** — text input bar, calls `/api/ask`, shows Claude answer inline
- **Topic clustering** — cards with keyword overlap (≥28%) grouped into expandable stacks with shadow UI
- **Article cards** — thumbnail, topic tag pill, headline, summary, save button, read link
- **Video cards** — YouTube embeds with play overlay
- **"Give me 5 more"** — fetches one more random topic batch at bottom

### Sports Tab
- **Fixture blocks** — grouped by competition, Sofascore-style (logo, time, team rows, score), Germany timezone
- **Sports RSS** — sports-topic cards moved here from Feed tab

### Saved / Later Tabs
- Saved cards by intent (💡 Interesting, 🔍 Research, 💼 Work relevant, 🗣️ Share)
- Read-later queue (📌 Read later tag)

### Notes Tab
- **Quick capture** — floating pencil FAB + bottom sheet
- **Living mindset** — "Your mind right now" block (≥3 notes, Claude 2nd-person)
- **Connections** — weekly note↔headline connections block
- **Weekly digest** — Monday boot generates digest note via `/api/digest`
- **Delete notes** — with inline confirm

### Settings Sheet
- Reading style (4 options)
- Interest brief (free text, passed to Claude)
- Topic chips (toggle active topics, persisted, passed as `?topics=` to API)
- Language toggle (include PT feeds, persisted, passed as `?pt=0`)

### Gestures & UX
- **Pull to refresh** — swipe down from top, spinner indicator
- **Swipe right** → opens save intent sheet
- **Swipe left** → dismisses card with fade
- **Search overlay** — header button, real-time across feed + saved + notes

---

## API: feed.js Key Params

```
GET /api/feed
  ?pref=tech,finance     preferred topics (2x more articles)
  ?style=direct          reading style
  ?brief=...             interest brief (≤300 chars)
  ?mindset=...           mindset summary (≤300 chars)
  ?seen=headline1|h2     recent saved headlines (dedup)
  ?topics=tech,science   active topics (default: all 7)
  ?pt=0                  skip Portuguese RSS feeds
  ?topic=sports          single-topic "give me 5 more" mode
```

**Topics:** `tech`, `startups`, `science`, `design`, `finance`, `culture`, `sports`

**TOPIC_QUERY overrides** in `api/feed.js`:
```js
sports:  'football soccer Palmeiras "Premier League" "Champions League" "Serie A"'
science: 'science research discovery breakthrough'
```

**Football leagues** in `api/sports.js`:
```js
LEAGUE_IDS = [39, 2, 71, 13, 135, 9, 140, 10]   // PL, UCL, Brasileirão, Copa BR, Serie A, WC, LaLiga, Ligue 1
TEAM_IDS   = [121, 529, 541, 6, 27, 26]           // Palmeiras, Barcelona, Real Madrid, Brazil, Portugal, Argentina
```

---

## CSS Topic Palette

```css
.tag-tech      { --tc:#60a5fa; --tb:rgba(96,165,250,.12); }
.tag-startups  { --tc:#a78bfa; --tb:rgba(167,139,250,.12); }
.tag-science   { --tc:#34d399; --tb:rgba(52,211,153,.12); }
.tag-design    { --tc:#fbbf24; --tb:rgba(251,191,36,.12); }
.tag-finance   { --tc:#22d3ee; --tb:rgba(34,211,238,.12); }
.tag-culture   { --tc:#fb7185; --tb:rgba(251,113,133,.12); }
.tag-sports    { --tc:#a3e635; --tb:rgba(163,230,53,.12); }
```

---

## Key JS Functions (index.html)

| Function | Purpose |
|---|---|
| `loadFeed()` | Fetches `/api/feed`, stores `feedCards`, calls `renderFeedPage()` |
| `renderFeedPage(cards, brief)` | Filters sports out, clusters, builds trending strip + ask bar, renders cards |
| `renderSportsPage()` | Calls `loadFixtures()` + renders `sportsRssCards` |
| `loadFixtures(targetPage)` | Fetches `/api/sports`, builds league blocks, appends to page |
| `clusterFeedCards(cards)` | Groups cards by keyword overlap (≥28%) into `{_isCluster, cards[]}` |
| `buildTrendingStrip(cards)` | Returns `#trending-strip` DOM element or null |
| `handleAskFeed()` | POSTs to `/api/ask`, shows answer in `#ask-answer` |
| `checkWeeklyDigest()` | Monday-only: POSTs to `/api/digest`, saves as note |
| `runSearch(q)` | Searches feedCards + savedCardsMap + notesArr, renders `#search-results` |
| `renderTopicChips()` | Rebuilds `#topic-chips` in settings from `customTopics` |
| `renderNotesPage()` | Renders notes + mindset block + connections block |
| `buildCard(card)` | Builds article card DOM element |
| `buildLeagueFixtureBlock(name, logo, fixtures)` | Builds Sofascore-style fixture block |
| `openIntentSheet(card, el)` | Opens save intent bottom sheet |
| `saveCard(card, tag, note)` | Saves to IDB + updates state |
| `computePreferredTopics()` | Returns top-2 topics by signal weight |
| `logSignal(type, topic, intent)` | Records save/read signal to IDB |

---

## Notes for Future Sessions

- **Never use `innerHTML` for user content** — use `textContent` or DOM creation
- **IndexedDB helpers:** `dbGetAll()`, `dbPut()`, `dbDelete()`, `dbGetAllNotes()`, `dbPutNote()`, `dbDeleteNote()`, `dbGetAllSignals()`, `dbPutSignal()`, `dbGetSetting(key)`, `dbPutSetting(key, val)`
- **Vercel deployment:** just `git push origin claude/pulse-news-feed-app-iS1fZ`
- **No build step** — changes to `index.html` go live immediately after push
- **CSS is all inline** in `<style>` block inside `index.html`
- **Swipe gestures** use global `touchstart/touchmove/touchend` with `.card` delegation — no per-card listeners needed
- **Pull to refresh** only triggers when `window.scrollY === 0` and drag > 70px
- **Topic clustering threshold** is 28% keyword overlap (`THRESHOLD = 0.28`) — tune if too aggressive/loose
