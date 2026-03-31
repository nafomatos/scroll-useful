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

// Fetch one article from EN feed and one from PT feed for a topic.
async function fetchTopicArticles(topic) {
  const fetchOne = async (url, lang) => {
    try {
      const feed = await rssParser.parseURL(url);
      const item = feed.items[0];
      if (!item) return null;
      return {
        topic,
        lang,
        headline: cleanHeadline(item.title),
        link: item.link,
        source: extractSource(item),
        pubDate: item.pubDate || item.isoDate || null,
      };
    } catch (err) {
      console.warn(`RSS fetch failed for "${topic}" (${lang}):`, err.message);
      return null;
    }
  };

  const [en, pt] = await Promise.all([fetchOne(rssUrlEN(topic), 'en'), fetchOne(rssUrlPT(topic), 'pt')]);
  return [en, pt].filter(Boolean);
}

// Scrape and extract article text via Readability, capped at MAX_TEXT_CHARS.
async function scrapeText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });

    if (!res.ok) return '';
    const html = await res.text();

    // Use the resolved URL for JSDOM so relative links parse correctly
    const finalUrl = res.url || url;
    const dom = new JSDOM(html, { url: finalUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article || !article.textContent) return '';

    return article.textContent.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  } catch {
    return '';
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

Return ONLY a valid JSON array — no markdown fences, no extra keys — in this exact shape:
[{"id":0,"summary":"..."},{"id":1,"summary":"..."},...]

Articles:

${numbered}`;

  let msg;
  try {
    msg = await claude.messages.create({
      model: 'claude-sonnet-4-6',
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

  // Parse; fall back to regex extraction if Claude wrapped it in markdown
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
    return [];
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
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    // 1. Fetch all RSS feeds in parallel
    const topicBatches = await Promise.all(TOPICS.map(fetchTopicArticles));
    const articles = topicBatches.flat(); // up to 14 articles

    if (articles.length === 0) {
      return res.status(502).json({ error: 'No articles fetched from RSS feeds.' });
    }

    // 2. Scrape article text in parallel (failures return empty string)
    const texts = await Promise.allSettled(articles.map((a) => scrapeText(a.link)));
    const articlesWithText = articles.map((a, i) => ({
      ...a,
      text: texts[i].status === 'fulfilled' ? texts[i].value : '',
    }));

    // 3. Single Claude call for all summaries
    const summaries = await summariseAll(articlesWithText);
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
      saved: false,
    }));

    return res.status(200).json({
      cards,
      count: cards.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('feed handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
