require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const axios = require('axios');
const { SYSTEM_PROMPT } = require('./system-prompt');

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// In-memory session store (keyed by sessionId)
const sessions = {};

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Chairo is running', version: '1.0.0' });
});

// ─── Main chat endpoint ───────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { message, sessionId, leadData } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required' });
  }

  // Init session if new
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      messages: [],
      leadData: leadData || {},
      createdAt: new Date().toISOString(),
    };
  }

  const session = sessions[sessionId];

  // Add user message to history
  session.messages.push({ role: 'user', content: message });

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...session.messages,
      ],
      temperature: 0.7,
      max_tokens: 300,
    });

    const reply = completion.choices[0].message.content;

    // Add assistant reply to history
    session.messages.push({ role: 'assistant', content: reply });

    // Detect hot intent for n8n trigger
    const hotIntentKeywords = ['book', 'schedule', 'call me', 'i\'m ready', 'send options', 'what\'s available', 'can i see', 'move forward'];
    const humanHandoffKeywords = ['human', 'agent', 'person', 'speak to someone', 'real person'];

    const msgLower = message.toLowerCase();
    const isHotIntent = hotIntentKeywords.some(k => msgLower.includes(k));
    const isHandoff = humanHandoffKeywords.some(k => msgLower.includes(k));

    // Fire n8n webhook if hot intent or handoff detected
    if ((isHotIntent || isHandoff) && process.env.N8N_WEBHOOK_URL) {
      try {
        await axios.post(process.env.N8N_WEBHOOK_URL, {
          sessionId,
          triggerType: isHandoff ? 'human_handoff' : 'hot_intent',
          message,
          leadData: session.leadData,
          timestamp: new Date().toISOString(),
        });
      } catch (webhookErr) {
        console.error('n8n webhook error:', webhookErr.message);
      }
    }

    return res.json({
      reply,
      sessionId,
      isHotIntent,
      isHandoff,
    });

  } catch (err) {
    console.error('OpenAI error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Update lead data for a session ──────────────────────────────────────────
app.post('/session/:sessionId/lead', (req, res) => {
  const { sessionId } = req.params;
  const leadData = req.body;

  if (!sessions[sessionId]) {
    sessions[sessionId] = { messages: [], leadData: {}, createdAt: new Date().toISOString() };
  }

  sessions[sessionId].leadData = { ...sessions[sessionId].leadData, ...leadData };
  res.json({ success: true, leadData: sessions[sessionId].leadData });
});

// ─── Get session history ──────────────────────────────────────────────────────
app.get('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!sessions[sessionId]) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(sessions[sessionId]);
});

// ─── Reset session ────────────────────────────────────────────────────────────
app.delete('/session/:sessionId', (req, res) => {
  delete sessions[sessionId];
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Chairo agent running on port ${PORT}`);
});