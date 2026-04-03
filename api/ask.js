// api/ask.js — Ask the Feed: answer questions about today's news
const Anthropic = require('@anthropic-ai/sdk');
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = async function handler(req, res) {
  // CORS pre-flight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, context } = req.body || {};

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question is required' });
  }

  try {
    const prompt = `You are a news analyst. Answer this question based only on today's news articles provided. Be concise (2-4 sentences). Question: ${question.slice(0, 500)}\n\nToday's articles:\n${(context || '').slice(0, 4000)}`;

    const msg = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const answer = msg.content[0]?.text || '';
    return res.status(200).json({ answer });
  } catch (err) {
    console.error('ask handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
