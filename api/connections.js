// api/connections.js — weekly intelligence connections between notes and saved news
const Anthropic = require('@anthropic-ai/sdk');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const notes = Array.isArray(body.notes) ? body.notes.slice(0, 30) : [];
  const headlines = Array.isArray(body.headlines) ? body.headlines.slice(0, 30) : [];

  if (notes.length < 5 || headlines.length < 10) {
    return res.status(400).json({ error: 'Not enough data for connections.' });
  }

  const notesSection = notes
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n');
  const headlinesSection = headlines
    .map((h, i) => `${i + 1}. ${h}`)
    .join('\n');

  const prompt = `You are a personal insight assistant. A user has been capturing quick thoughts in their notes app and saving news articles. Your job is to find 2-3 genuine intellectual connections between what they've been privately thinking about and what's happening in the world.

Focus on: surprising resonances, unexpected parallels, tensions where their thinking meets current events, or moments where their concerns appear in the news in a new form.

Be specific and concrete — name the actual note theme and the actual news story. Each connection should feel like a small revelation, not a generic observation.

USER'S NOTES (their private thoughts, unfiltered):
${notesSection}

SAVED NEWS HEADLINES (what they've been reading and bookmarking):
${headlinesSection}

Return ONLY valid JSON — no markdown fences:
{"connections":["connection 1 text (1-2 sentences)","connection 2 text (1-2 sentences)","connection 3 text (1-2 sentences)"]}

If you can only find 2 genuine connections, return 2. Never force a connection that isn't there.`;

  try {
    const msg = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = (msg.content[0]?.text || '').trim();
    let connections = [];

    try {
      const parsed = JSON.parse(raw);
      connections = Array.isArray(parsed.connections) ? parsed.connections : [];
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { connections = JSON.parse(m[0]).connections || []; } catch { /* skip */ }
      }
    }

    return res.status(200).json({ connections: connections.filter(c => typeof c === 'string') });
  } catch (err) {
    console.error('connections error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
