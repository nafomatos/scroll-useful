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

const rssParser = new Parser({ timeout: 8000 });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 });

// Google News RSS URLs — one English (US), one Portuguese (BR)
function rssUrlEN(topic) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`;
}
function rssUrlPT(topic) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=pt-BR&gl=BR&ceid=BR:pt`;
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
async function fetchTopicArticles(topic, count = 1) {
  const fetchMany = async (url, lang, max) => {
    try {
      const feed = await rssParser.parseURL(url);
      return feed.items.slice(0, max).map(item => ({
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

  const [en, pt] = await Promise.all([
    fetchMany(rssUrlEN(topic), 'en', count),
    fetchMany(rssUrlPT(topic), 'pt', 1),
  ]);
  return [...en, ...pt];
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

// Ask Claude to summarise all articles in one shot and return JSON array.
async function summariseAll(articles) {
  const numbered = articles
    .map(
      (a, i) =>
        `[${i}] TOPIC: ${a.topic}\nHEADLINE: ${a.headline}\nSOURCE: ${a.source}\nTEXT: ${a.text || '(not available)'}`,
    )
    .join('\n\n---\n\n');

  const prompt = `You are a sharp, concise news editor. For each article below write a 2-3 sentence summary in ENGLISH that captures the key facts and why it matters. Even if the article is in Portuguese, write the summary in English.

Also write a single "daily_brief" — one punchy sentence (max 25 words) capturing the overall vibe across all topics today. Be specific, not generic. Example: "Tech is heavy on AI layoffs today, Science has a surprising materials breakthrough, and Sports is all about managerial shakeups."

Return ONLY a valid JSON object — no markdown fences — in this exact shape:
{"daily_brief":"...","summaries":[{"id":0,"summary":"..."},{"id":1,"summary":"..."},...]}

Articles:

${numbered}`;

  let msg;
  try {
    msg = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    // Fall back to Haiku if Sonnet is overloaded (529) or rate-limited (429)
    if (err.status === 529 || err.status === 429) {
      console.warn('Sonnet overloaded, falling back to Haiku');
      msg = await claude.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });
    } else {
      throw err;
    }
  }

  const raw = (msg.content[0]?.text || '').trim();

  // Parse the new envelope shape; fall back gracefully
  try {
    const parsed = JSON.parse(raw);
    // Handle both new {daily_brief, summaries:[]} and legacy [] shapes
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

  // Single-topic "more" mode vs full feed mode
  const requestedTopic = req.query && req.query.topic;
  const singleTopic = requestedTopic && TOPICS.includes(requestedTopic) ? requestedTopic : null;

  // Single-topic results are fresh on every request; full feed is cached 2 h
  res.setHeader(
    'Cache-Control',
    singleTopic ? 'no-store' : 's-maxage=7200, stale-while-revalidate=600',
  );

  try {
    // 1. Fetch RSS feeds
    let articles;
    if (singleTopic) {
      // Fetch up to 5 EN articles for the requested topic (no PT to stay fast)
      articles = await fetchTopicArticles(singleTopic, 5);
      articles = articles.filter(a => a.lang === 'en').slice(0, 5);
    } else {
      const topicBatches = await Promise.all(TOPICS.map(t => fetchTopicArticles(t, 1)));
      articles = topicBatches.flat(); // up to 14 articles
    }

    if (articles.length === 0) {
      return res.status(502).json({ error: 'No articles fetched from RSS feeds.' });
    }

    // 2. Scrape article text + thumbnail in parallel
    const scraped = await Promise.allSettled(articles.map((a) => scrapeArticle(a.link)));
    const articlesWithText = articles.map((a, i) => ({
      ...a,
      text:      scraped[i].status === 'fulfilled' ? scraped[i].value.text      : '',
      thumbnail: scraped[i].status === 'fulfilled' ? scraped[i].value.thumbnail : null,
    }));

    // 3. Single Claude call for all summaries + daily brief
    const { daily_brief, summaries } = await summariseAll(articlesWithText);
    const summaryMap = Object.fromEntries(summaries.map((s) => [s.id, s.summary]));

    // 4. Build response cards
    const cards = articlesWithText.map((a, i) => ({
      id: `${a.topic}-${i}`,
      topic: a.topic,
      type: 'article',
      headline: a.headline,
      summary: summaryMap[i] || '',
      source: a.source,
      link: a.link,
      pubDate: a.pubDate,
      thumbnail: a.thumbnail || null,
      saved: false,
    }));

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
