# Flightpath Backend

Hono-based backend that exposes a Claude Agent via HTTP API.

## Prerequisites

- [Bun](https://bun.sh) or Node.js 18+ installed
- Claude Code CLI logged in (`claude login`)

## Authentication

The Claude Agent SDK uses Claude Code's authentication. Make sure you're logged in:

```bash
claude login
```

No separate API key configuration is needed.

## Development

Install dependencies and start the dev server:

```bash
bun install
bun run dev
```

The server starts at `http://localhost:8787`.

## API Endpoints

### GET /health

Health check endpoint.

```bash
curl http://localhost:8787/health
# {"ok":true}
```

### POST /api/agent

Send a message to the Claude agent.

**Request:**
```json
{
  "message": "Hello, how are you?"
}
```

**Response:**
```json
{
  "reply": "I'm doing well, thank you for asking!",
  "requestId": "abc123..."
}
```

**Example:**
```bash
curl -X POST http://localhost:8787/api/agent \
  -H "Content-Type: application/json" \
  -d '{"message":"hello"}'
```

## Testing

Run tests (agent is mocked, no real API calls):

```bash
bun test
```

## Runtime Notes

The Claude Agent SDK spawns Claude Code as a subprocess, which requires Node.js. The default `dev` script uses `tsx` for Node.js TypeScript support. Alternatively:

- `bun run dev` - Uses tsx (Node.js) - **recommended for Agent SDK**
- `bun run dev:bun` - Uses Bun directly (may have compatibility issues)
- `bun run dev:wrangler` - Wrangler dev (Agent SDK not compatible with Workers)
