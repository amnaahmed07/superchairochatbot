# Chairo — Supanova AI Concierge Agent

Premium AI concierge for Supanova's Bahamas luxury real estate platform.

## Stack
- Node.js + Express
- OpenAI GPT-4o
- n8n webhook integration

## Setup

```bash
npm install
cp .env.example .env
# Fill in your OPENAI_API_KEY and N8N_WEBHOOK_URL
npm start
```

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | / | Health check |
| POST | /chat | Send a message to Chairo |
| POST | /session/:id/lead | Update lead data for a session |
| GET | /session/:id | Get session history |
| DELETE | /session/:id | Reset a session |

## Chat Request Example

```json
POST /chat
{
  "message": "I'm interested in investment properties in Nassau",
  "sessionId": "user-abc-123",
  "leadData": {
    "name": "John Smith",
    "email": "john@example.com"
  }
}
```

## Chat Response Example

```json
{
  "reply": "Nassau has some excellent investment opportunities right now. Are you looking at rental income properties, or more long-term capital appreciation?",
  "sessionId": "user-abc-123",
  "isHotIntent": false,
  "isHandoff": false
}
```

## Environment Variables

See `.env.example` for all required variables.