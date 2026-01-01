# Flightpath

A minimal Claude Agent vertical slice demonstrating end-to-end integration with a web UI for observing agent runs in real-time.

## Project Structure

```
flightpath/
├── index.ts          # CLI client for calling the backend
├── backend/          # Hono-based HTTP server with Claude Agent
│   └── src/
│       ├── index.ts       # Server entry + routes
│       ├── lib/agent.ts   # Claude Agent SDK wrapper
│       └── lib/runs.ts    # Run session model with SSE streaming
├── ui/               # React web UI for observing runs
│   └── src/
│       ├── App.tsx        # Main app with run list and detail view
│       └── lib/api.ts     # API client with SSE support
```

## Prerequisites

- [Bun](https://bun.sh) or Node.js 18+ installed
- Claude Code CLI logged in (`claude login`)

## Quick Start

### 1. Install Dependencies

```bash
# Root dependencies
bun install

# Backend dependencies
cd backend && bun install && cd ..

# UI dependencies
cd ui && bun install && cd ..
```

### 2. Verify Claude Login

The Claude Agent SDK uses Claude Code authentication:

```bash
claude login
```

### 3. Start the Backend

```bash
cd backend
bun run dev
```

The server runs at `http://localhost:8787`.

### 4. Use the CLI

In a separate terminal (from root folder):

```bash
bun run ask "hello"
```

Or with custom backend URL:

```bash
BACKEND_URL=http://localhost:8787 bun run ask "what is 2+2?"
```

### 5. Use the Web UI

Start the UI development server (in a separate terminal):

```bash
bun run dev:ui
# Or: cd ui && bun run dev
```

Open `http://localhost:5173` in your browser. The UI shows:
- Left panel: List of recent runs
- Right panel: Real-time events feed and final reply
- Input box to submit new messages

## Environment Variables

### CLI (optional)

| Variable    | Required | Default               | Description     |
| ----------- | -------- | --------------------- | --------------- |
| BACKEND_URL | No       | http://localhost:8787 | Backend API URL |

### Backend (optional)

| Variable | Required | Default | Description |
| -------- | -------- | ------- | ----------- |
| PORT     | No       | 8787    | Server port |

### UI (optional)

| Variable         | Required | Default               | Description     |
| ---------------- | -------- | --------------------- | --------------- |
| VITE_BACKEND_URL | No       | http://localhost:8787 | Backend API URL |

## Testing

Run backend tests (agent is mocked, no API calls):

```bash
bun test
# Or: cd backend && bun test
```

## API Reference

See [backend/README.md](backend/README.md) for API documentation.
