// api/mindset.js — "Your mind right now" living summary of user notes
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

  const { notes = [] } = req.body || {};
  if (notes.length < 3) {
    return res.status(400).json({ error: 'Need at least 3 notes.' });
  }

  const notesList = notes
    .slice(0, 40)
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n');

  const prompt = `You are a thoughtful observer of someone's inner world. Below are quick notes a person has captured — raw thoughts, observations, ideas, things on their mind.

Write 2-3 sentences that capture the recurring themes, underlying concerns, or patterns in their thinking. Be specific and perceptive — name the actual themes you see. Speak directly to the person in second person ("You seem to be…", "There's a thread of…"). Don't be generic or flattering.

NOTES:
${notesList}

Return ONLY the 2-3 sentence summary. No preamble, no extra text.`;

  try {
    const msg = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const summary = (msg.content[0]?.text || '').trim();
    return res.status(200).json({ summary });
  } catch (err) {
    console.error('mindset error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
