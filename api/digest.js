// api/digest.js — Weekly digest generator
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

  const { savedHeadlines = [], savedIntents = [], noteTexts = [] } = req.body || {};

  try {
    const headlinesList = savedHeadlines.slice(0, 30).map((h, i) => `${i + 1}. ${h}`).join('\n');
    const intentsList = savedIntents.slice(0, 30).filter(Boolean).join(', ');
    const notesList = noteTexts.slice(0, 20).map((n, i) => `${i + 1}. ${n}`).join('\n');

    const prompt = `Write a personal weekly digest (1 short paragraph, ~80 words) for someone who read and saved these news articles this past week. Mention the main themes they engaged with, note any patterns in what they found interesting (based on save intents), and reference their personal notes if relevant. Make it feel like a personal reflection, not a list. Tone: warm, insightful, second person.

Saved articles:
${headlinesList || 'None'}

Save intents (how they tagged articles): ${intentsList || 'None'}

Personal notes:
${notesList || 'None'}

Write only the paragraph, no preamble.`;

    const msg = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const digest = msg.content[0]?.text || '';
    return res.status(200).json({ digest });
  } catch (err) {
    console.error('digest handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
