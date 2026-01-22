# Cloudflare AI Realtime Chat Agent

A production-ready AI-powered chat application built on Cloudflare's developer platform, demonstrating the full stack of AI agent capabilities.

## Requirements Checklist

| Requirement | Implementation | Status |
|-------------|----------------|--------|
| **LLM** | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) | Yes |
| **Workflow/Coordination** | Cloudflare Workflows for automated memory summarization | Yes |
| **User Input** | Real-time chat via WebSocket (Pages UI + Durable Object backend) | Yes |
| **Memory/State** | SQLite-backed Durable Objects via Agents SDK SQL API | Yes |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    WebSocket     ┌────────────────────────┐  │
│  │  Pages UI    │◄────────────────►│     ChatAgent (DO)     │  │
│  │  (Frontend)  │                  │                        │  │
│  └──────────────┘                  │  ┌──────────────────┐  │  │
│                                    │  │  SQLite Storage  │  │  │
│                                    │  │  - messages      │  │  │
│                                    │  │  - profile       │  │  │
│                                    │  └──────────────────┘  │  │
│                                    │                        │  │
│                                    │  ┌──────────────────┐  │  │
│  ┌──────────────┐                  │  │   Workers AI     │  │  │
│  │  Workflow    │◄─────────────────│  │   Llama 3.3      │  │  │
│  │  (Summary)   │                  │  └──────────────────┘  │  │
│  └──────────────┘                  └────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Features

- **Streaming Responses**: Real-time token-by-token streaming from Llama 3.3
- **Persistent Memory**: Conversation history stored in SQLite-backed Durable Objects
- **Smart Memory**: Automatic profile summarization via Workflows (triggered every 8 messages)
- **Session Management**: Sessions persist across browser refreshes via localStorage
- **Edge-Powered**: Low-latency responses from Cloudflare's global network
- **Modern UI**: Polished chat interface with dark theme and smooth animations

## Project Structure

```
.
├── src/
│   ├── index.ts       # Worker entry point, routes requests
│   ├── agent.ts       # ChatAgent Durable Object class
│   └── workflow.ts    # Memory summarization workflow
├── public/
│   ├── index.html     # Chat UI
│   ├── styles.css     # Styling
│   └── app.js         # WebSocket client
├── wrangler.jsonc     # Cloudflare configuration
├── package.json
└── tsconfig.json
```

## Prerequisites

- Node.js 18+
- Cloudflare account with access to:
  - Workers
  - Durable Objects
  - Workers AI
  - Workflows

## Setup

1. **Clone and install dependencies**
   ```bash
   git clone <repo-url>
   cd cf-ai-chat-agent
   npm install
   ```

2. **Login to Cloudflare**
   ```bash
   npx wrangler login
   ```

3. **Run locally**
   ```bash
   npm run dev
   ```

4. **Open in browser**
   - Navigate to `http://localhost:8787`

## Deploy

```bash
npm run deploy
```

This deploys:
- The Worker with ChatAgent Durable Object
- The SummaryWorkflow
- Static assets (frontend) served from the Worker

## Demo Instructions

1. **Open the deployed URL** in your browser
2. **Send a message** - observe streaming AI responses
3. **Refresh the page** - your conversation persists (same session ID)
4. **Send 8+ messages** - triggers the summarization workflow
5. **Check the profile memory** - future conversations use context from your profile
6. **Click reset** - starts a fresh session

## How It Works

### ChatAgent (Durable Object)
- Extends the Agents SDK `Agent` class
- Stores messages in SQLite `messages` table
- Stores profile summary in SQLite `profile` table
- Handles WebSocket connections for real-time chat
- Streams responses from Workers AI Llama 3.3

### SummaryWorkflow
- Triggered after every 8 new messages
- Fetches recent conversation from the agent
- Asks LLM to extract key user facts/preferences
- Updates the profile summary for future context

### Frontend
- Pure HTML/CSS/JavaScript (no frameworks)
- WebSocket connection with auto-reconnect
- Session ID stored in localStorage for persistence
- Streaming message display with typing indicators

## API

### WebSocket Endpoint
```
wss://<worker-domain>/ws?session=<session-id>
```

**Send:**
```json
{ "type": "user_message", "text": "Hello!" }
```

**Receive:**
```json
{ "type": "chunk", "content": "Hello" }
{ "type": "done" }
```

### Health Check
```
GET /api/health
```

## Technologies Used

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) - Llama 3.3 70B
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)

## License

MIT
