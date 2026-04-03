// api/feed.js — Pulse news feed serverless function
// Single Claude call for all summaries to stay within Vercel's 60s budget

const Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const Anthropic = require('@anthropic-ai/sdk');

const TOPICS = ['tech', 'startups', 'science', 'design', 'finance', 'culture', 'sports'];
const MAX_PER_TOPIC = 2;
const MAX_TEXT_CHARS = 1500;
const SCRAPE_TIMEOUT_MS = 7000;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// Override RSS search query for topics where the bare topic name returns poor results
const TOPIC_QUERY = {
  sports:  'football soccer Palmeiras "Premier League" "Champions League" "Serie A"',
  science: 'science research discovery breakthrough',
};

const rssParser = new Parser({ timeout: 8000 });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 });

// Google News RSS URLs — one English (US), one Portuguese (BR)
function rssUrlEN(topic) {
  const q = TOPIC_QUERY[topic] || topic;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}
function rssUrlPT(topic) {
  const q = TOPIC_QUERY[topic] || topic;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=pt-BR&gl=BR&ceid=BR:pt`;
}

// Google News titles are "Headline - Publisher". Strip the publisher suffix.
function cleanHeadline(title = '') {
  return title.replace(/ - [^-]+$/, '').trim() || title.trim();
}

// Pull publisher name from title suffix or fall back to link hostname.
function extractSource(item) {
  const match = (item.title || '').match(/ - ([^-]+)$/);
  if (match) return match[1].trim();
  try {
    return new URL(item.link).hostname.replace(/^www\./, '');
  } catch {
    return 'Unknown';
  }
}

// Fetch articles for a topic. count controls how many EN items to return (PT always 1).
async function fetchTopicArticles(topic, count = 1, includePT = true) {
  const cutoff = Date.now() - MAX_AGE_MS;
  const fetchMany = async (url, lang, max) => {
    try {
      const feed = await rssParser.parseURL(url);
      const recent = feed.items.filter(item => {
        const d = item.pubDate || item.isoDate;
        if (!d) return true; // keep if no date info
        const t = new Date(d).getTime();
        return isNaN(t) || t > cutoff;
      });
      return recent.slice(0, max).map(item => ({
        topic,
        lang,
        headline: cleanHeadline(item.title),
        link: item.link,
        source: extractSource(item),
        pubDate: item.pubDate || item.isoDate || null,
      }));
    } catch (err) {
      console.warn(`RSS fetch failed for "${topic}" (${lang}):`, err.message);
      return [];
    }
  };

  if (!includePT) {
    const en = await fetchMany(rssUrlEN(topic), 'en', count);
    return en;
  }

  const [en, pt] = await Promise.all([
    fetchMany(rssUrlEN(topic), 'en', count),
    fetchMany(rssUrlPT(topic), 'pt', 1),
  ]);
  return [...en, ...pt];
}

// Fetch 1 YouTube video for a topic via the Data API v3.
async function fetchTopicVideo(topic) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  try {
    const publishedAfter = new Date(Date.now() - MAX_AGE_MS).toISOString();
    const qs = new URLSearchParams({
      part: 'snippet',
      q: topic,
      type: 'video',
      maxResults: '1',
      relevanceLanguage: 'en',
      order: 'relevance',
      publishedAfter,
      key,
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${qs}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items?.[0];
    if (!item) return null;
    const { videoId } = item.id;
    const s = item.snippet;
    return {
      topic,
      type: 'video',
      headline: s.title,
      source: s.channelTitle,
      link: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || null,
      pubDate: s.publishedAt || null,
      text: s.description || '',
    };
  } catch (err) {
    console.warn(`YouTube fetch failed for "${topic}":`, err.message);
    return null;
  }
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ON_GOOGLE = /\bgoogle\.com\b/;

// Step 1 — resolve a Google News redirect to the real article URL.
// Tries og:url, canonical, meta-refresh, then any non-Google link in the page.
async function resolveRedirect(googleUrl) {
  try {
    const res = await fetch(googleUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    });
    const landedUrl = res.url || googleUrl;

    // HTTP redirects already took us off Google — done
    if (!ON_GOOGLE.test(new URL(landedUrl).hostname)) return landedUrl;

    const html = await res.text();
    const doc = new JSDOM(html, { url: landedUrl }).window.document;

    const candidates = [
      doc.querySelector('meta[property="og:url"]')?.getAttribute('content'),
      doc.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      // meta-refresh: content="0; url=https://..."
      doc.querySelector('meta[http-equiv="refresh"]')
        ?.getAttribute('content')?.match(/url=([^\s;'"]+)/i)?.[1],
      // any external non-Google link in the page body
      ...[...doc.querySelectorAll('a[href^="http"]')].map(a => a.getAttribute('href')),
    ];

    for (const c of candidates) {
      if (!c) continue;
      try {
        const u = new URL(c.replace(/&amp;/g, '&'), landedUrl);
        if (!ON_GOOGLE.test(u.hostname)) return u.href;
      } catch { /* skip */ }
    }
    return null; // could not resolve
  } catch {
    return null;
  }
}

// Step 2 — fetch the real article page and pull out og:image + readable text.
async function scrapeArticle(url) {
  try {
    // Resolve Google News redirects first
    const articleUrl = ON_GOOGLE.test(new URL(url).hostname)
      ? await resolveRedirect(url)
      : url;

    if (!articleUrl) return { text: '', thumbnail: null };

    const res = await fetch(articleUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
    if (!res.ok) return { text: '', thumbnail: null };

    const html = await res.text();
    const finalUrl = res.url || articleUrl;
    const dom = new JSDOM(html, { url: finalUrl });
    const doc = dom.window.document;

    // og:image from the real article page
    const imgRaw =
      doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      doc.querySelector('meta[property="twitter:image"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
    let thumbnail = null;
    if (imgRaw) {
      try { thumbnail = new URL(imgRaw, finalUrl).href; } catch { /* ignore */ }
    }

    // Readable text for Claude
    const reader = new Readability(doc);
    const article = reader.parse();
    const text = article?.textContent
      ? article.textContent.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS)
      : '';

    return { text, thumbnail };
  } catch {
    return { text: '', thumbnail: null };
  }
}

const STYLE_INSTRUCTIONS = {
  direct:     'Write summaries that are concise and to the point — no fluff, key facts only.',
  narrative:  'Write summaries with a narrative flow — give context and connect events to a bigger picture.',
  analytical: 'Write summaries with analytical depth — surface implications, tensions, and what to watch.',
  casual:     'Write summaries in a casual, conversational tone — like explaining it to a smart friend.',
};

// Ask Claude to summarise all articles in one shot and return JSON array.
async function summariseAll(articles, style = 'direct', seenHeadlines = [], interestBrief = '', mindset = '') {
  const numbered = articles
    .map(
      (a, i) =>
        `[${i}] TOPIC: ${a.topic}\nHEADLINE: ${a.headline}\nSOURCE: ${a.source}\nTEXT: ${a.text || '(not available)'}`,
    )
    .join('\n\n---\n\n');

  const styleNote = STYLE_INSTRUCTIONS[style] || STYLE_INSTRUCTIONS.direct;

  const seenSection = seenHeadlines.length > 0
    ? `\n\nPREVIOUSLY SEEN HEADLINES — if any new article covers the exact same story as one of these, set "duplicate":true for that article:\n${seenHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
    : '';

  const interestSection = interestBrief
    ? `\n\nUSER INTERESTS: The user is particularly interested in: ${interestBrief}. When summarising, highlight relevance to these interests where applicable and prioritise surfacing stories connected to them.`
    : '';

  const mindsetSection = mindset
    ? `\n\nUSER'S CURRENT MINDSET: The user is currently thinking about: ${mindset}. Where relevant, highlight connections between articles and these themes.`
    : '';

  const prompt = `You are a sharp morning briefing editor. For each article below write a 2-3 sentence summary in ENGLISH. Even if the article is in Portuguese, write in English.

STYLE: ${styleNote}${interestSection}${mindsetSection}

Also write a "daily_brief" — 2 to 3 punchy sentences as a morning editorial. Use 2–3 relevant emojis woven in naturally (not forced at the start of every sentence). Don't list headlines. Connect the dots between topics, surface the tension or irony, give a vivid sense of what's happening today. Be sharp and specific.${seenSection}

Return ONLY a valid JSON object — no markdown fences — in this exact shape:
{"daily_brief":"...","summaries":[{"id":0,"summary":"...","duplicate":false},{"id":1,"summary":"...","duplicate":false},...]}

Only set "duplicate":true when the article covers the exact same news event as a previously seen headline. Different angles on the same broad topic do NOT count as duplicates.

Articles:

${numbered}`;

  const msg = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = (msg.content[0]?.text || '').trim();

  // Parse the envelope shape; fall back gracefully
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { daily_brief: '', summaries: parsed };
    return { daily_brief: parsed.daily_brief || '', summaries: parsed.summaries || [] };
  } catch {
    const obj = raw.match(/\{[\s\S]*\}/);
    if (obj) {
      try {
        const parsed = JSON.parse(obj[0]);
        return { daily_brief: parsed.daily_brief || '', summaries: parsed.summaries || [] };
      } catch { /* fall through */ }
    }
    const arr = raw.match(/\[[\s\S]*\]/);
    if (arr) return { daily_brief: '', summaries: JSON.parse(arr[0]) };
    return { daily_brief: '', summaries: [] };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  // CORS pre-flight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  // Parse query params
  const requestedTopic = req.query && req.query.topic;
  const singleTopic = requestedTopic && TOPICS.includes(requestedTopic) ? requestedTopic : null;

  // Custom topics filter
  const topicsRaw = req.query && req.query.topics;
  const activeTopics = topicsRaw
    ? topicsRaw.split(',').filter(t => /^[a-z0-9 ]+$/i.test(t.trim())).map(t => t.trim()).slice(0, 15)
    : TOPICS;

  // Portuguese articles toggle
  const includePT = req.query && req.query.pt !== '0';

  const prefRaw = req.query && req.query.pref;
  const preferredTopics = prefRaw
    ? prefRaw.split(',').map(t => t.trim()).filter(t => TOPICS.includes(t)).slice(0, 2)
    : [];

  const seenRaw = req.query && req.query.seen;
  const seenHeadlines = seenRaw
    ? decodeURIComponent(seenRaw).split('|').map(h => h.trim()).filter(Boolean).slice(0, 10)
    : [];

  const styleRaw = req.query && req.query.style;
  const style = Object.keys(STYLE_INSTRUCTIONS).includes(styleRaw) ? styleRaw : 'direct';

  const briefRaw = req.query && req.query.brief;
  const interestBrief = briefRaw ? String(briefRaw).slice(0, 300).trim() : '';

  const mindsetRaw = req.query && req.query.mindset;
  const mindset = mindsetRaw ? String(mindsetRaw).slice(0, 300).trim() : '';

  // Personalized requests are not shared-cached; default full feed is cached 2 h
  const isPersonalized = preferredTopics.length > 0 || seenHeadlines.length > 0;
  res.setHeader(
    'Cache-Control',
    (singleTopic || isPersonalized) ? 'no-store' : 's-maxage=7200, stale-while-revalidate=600',
  );

  try {
    let allItems;

    if (singleTopic) {
      // ── Single-topic "give me more" mode ──────────────────────────────────
      const [articles, video] = await Promise.all([
        fetchTopicArticles(singleTopic, 5).then(a => a.filter(x => x.lang === 'en').slice(0, 4)),
        fetchTopicVideo(singleTopic),
      ]);
      if (articles.length === 0) {
        return res.status(502).json({ error: 'No articles fetched from RSS feeds.' });
      }
      const scraped = await Promise.allSettled(articles.map(a => scrapeArticle(a.link)));
      const rich = articles.map((a, i) => ({
        ...a,
        text:      scraped[i].status === 'fulfilled' ? scraped[i].value.text      : '',
        thumbnail: scraped[i].status === 'fulfilled' ? scraped[i].value.thumbnail : null,
      }));
      if (video && rich.length >= 2) rich.splice(2, 0, video);
      else if (video) rich.push(video);
      allItems = rich;

    } else {
      // ── Full feed mode ─────────────────────────────────────────────────────
      // Preferred topics get 3 EN articles; others get 1
      const [articleBatches, videoResults] = await Promise.all([
        Promise.all(activeTopics.map(t => fetchTopicArticles(t, preferredTopics.includes(t) ? 3 : 1, includePT))),
        Promise.all(activeTopics.map(t => fetchTopicVideo(t))),
      ]);
      const articles = articleBatches.flat();
      if (articles.length === 0) {
        return res.status(502).json({ error: 'No articles fetched from RSS feeds.' });
      }

      const scraped = await Promise.allSettled(articles.map(a => scrapeArticle(a.link)));
      const articlesRich = articles.map((a, i) => ({
        ...a,
        text:      scraped[i].status === 'fulfilled' ? scraped[i].value.text      : '',
        thumbnail: scraped[i].status === 'fulfilled' ? scraped[i].value.thumbnail : null,
      }));

      const videoByTopic = Object.fromEntries(
        videoResults.filter(Boolean).map(v => [v.topic, v])
      );
      allItems = activeTopics.flatMap(topic => {
        const topicArticles = articlesRich.filter(a => a.topic === topic);
        const video = videoByTopic[topic];
        return video ? [...topicArticles, video] : topicArticles;
      });
    }

    // 2. Single Claude call — summaries + duplicate detection
    const { daily_brief, summaries } = await summariseAll(allItems, style, seenHeadlines, interestBrief, mindset);
    const summaryMap = Object.fromEntries(summaries.map(s => [s.id, s]));

    // 3. Build response cards
    const cards = allItems.map((item, i) => {
      const s = summaryMap[i] || {};
      return {
        id: `${item.topic}-${item.type || 'article'}-${i}`,
        topic: item.topic,
        type: item.type || 'article',
        headline: item.headline,
        summary: s.summary || '',
        duplicate: s.duplicate === true,
        source: item.source,
        link: item.link,
        pubDate: item.pubDate,
        thumbnail: item.thumbnail || null,
        saved: false,
      };
    });

    return res.status(200).json({
      daily_brief,
      cards,
      count: cards.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('feed handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
