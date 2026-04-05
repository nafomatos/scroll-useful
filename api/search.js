// api/search.js — Live news search: fetch articles from Google News for any query
const Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const Anthropic = require('@anthropic-ai/sdk');

const MAX_TEXT_CHARS = 1200;
const SCRAPE_TIMEOUT_MS = 6000;

const rssParser = new Parser({ timeout: 8000 });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ON_GOOGLE = /\bgoogle\.com\b/;

function cleanHeadline(title = '') {
  return title.replace(/ - [^-]+$/, '').trim() || title.trim();
}

function extractSource(item) {
  const match = (item.title || '').match(/ - ([^-]+)$/);
  if (match) return match[1].trim();
  try { return new URL(item.link).hostname.replace(/^www\./, ''); } catch { return 'Unknown'; }
}

async function resolveRedirect(googleUrl) {
  try {
    const res = await fetch(googleUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    });
    const landedUrl = res.url || googleUrl;
    if (!ON_GOOGLE.test(new URL(landedUrl).hostname)) return landedUrl;

    const html = await res.text();
    const doc = new JSDOM(html, { url: landedUrl }).window.document;
    const candidates = [
      doc.querySelector('meta[property="og:url"]')?.getAttribute('content'),
      doc.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      doc.querySelector('meta[http-equiv="refresh"]')
        ?.getAttribute('content')?.match(/url=([^\s;'"]+)/i)?.[1],
      ...[...doc.querySelectorAll('a[href^="http"]')].map(a => a.getAttribute('href')),
    ];
    for (const c of candidates) {
      if (!c) continue;
      try {
        const u = new URL(c.replace(/&amp;/g, '&'), landedUrl);
        if (!ON_GOOGLE.test(u.hostname)) return u.href;
      } catch { /* skip */ }
    }
    return null;
  } catch { return null; }
}

async function scrapeArticle(url) {
  try {
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

    const imgRaw =
      doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
    let thumbnail = null;
    if (imgRaw) { try { thumbnail = new URL(imgRaw, finalUrl).href; } catch { /* ignore */ } }

    const reader = new Readability(doc);
    const article = reader.parse();
    const text = article?.textContent
      ? article.textContent.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS)
      : '';

    return { text, thumbnail };
  } catch { return { text: '', thumbnail: null }; }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const q = req.query?.q ? String(req.query.q).slice(0, 200).trim() : '';
  if (!q) return res.status(400).json({ error: 'q param required' });

  try {
    // Fetch from Google News RSS for this query
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    let feed;
    try {
      feed = await rssParser.parseURL(rssUrl);
    } catch {
      return res.status(502).json({ error: 'Could not fetch news for this query.' });
    }

    const items = feed.items.slice(0, 5);
    if (items.length === 0) return res.status(200).json({ answer: '', cards: [] });

    const articles = items.map(item => ({
      topic: 'search',
      headline: cleanHeadline(item.title),
      link: item.link,
      source: extractSource(item),
      pubDate: item.pubDate || item.isoDate || null,
    }));

    // Scrape articles in parallel (best-effort)
    const scraped = await Promise.allSettled(articles.map(a => scrapeArticle(a.link)));
    const rich = articles.map((a, i) => ({
      ...a,
      text:      scraped[i].status === 'fulfilled' ? scraped[i].value.text      : '',
      thumbnail: scraped[i].status === 'fulfilled' ? scraped[i].value.thumbnail : null,
    }));

    // Single Claude call: answer + per-article summaries
    const numbered = rich
      .map((a, i) => `[${i}] HEADLINE: ${a.headline}\nSOURCE: ${a.source}\nTEXT: ${a.text || '(not available)'}`)
      .join('\n\n---\n\n');

    const prompt = `You are a news analyst. The user searched for: "${q.slice(0, 200)}"

Write a short answer (2-3 sentences) summarising what's happening on this topic right now, based on the articles below. Be direct and specific.

Then write a 1-2 sentence summary for each article.

Return ONLY valid JSON, no markdown fences:
{"answer":"...","summaries":[{"id":0,"summary":"..."},{"id":1,"summary":"..."},...]}

Articles:

${numbered}`;

    const msg = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    let answer = '';
    let summaryMap = {};
    try {
      const raw = (msg.content[0]?.text || '').trim();
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      answer = parsed.answer || '';
      summaryMap = Object.fromEntries((parsed.summaries || []).map(s => [s.id, s.summary]));
    } catch { /* fallback: no summaries */ }

    const cards = rich.map((a, i) => ({
      id: `search-${i}-${Date.now()}`,
      topic: 'search',
      type: 'article',
      headline: a.headline,
      summary: summaryMap[i] || '',
      source: a.source,
      link: a.link,
      pubDate: a.pubDate,
      thumbnail: a.thumbnail || null,
      saved: false,
    }));

    return res.status(200).json({ answer, cards });
  } catch (err) {
    console.error('search handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
