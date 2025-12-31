# Flightpath

A minimal Claude Agent vertical slice demonstrating end-to-end integration.

## Project Structure

```
flightpath/
├── index.ts          # CLI client for calling the backend
├── backend/          # Hono-based HTTP server with Claude Agent
│   └── src/
│       ├── index.ts       # Server entry + routes
│       └── lib/agent.ts   # Claude Agent SDK wrapper
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

## Environment Variables

### CLI (optional)

| Variable    | Required | Default               | Description     |
| ----------- | -------- | --------------------- | --------------- |
| BACKEND_URL | No       | http://localhost:8787 | Backend API URL |

### Backend (optional)

| Variable | Required | Default | Description |
| -------- | -------- | ------- | ----------- |
| PORT     | No       | 8787    | Server port |

## Testing

Run backend tests (agent is mocked, no API calls):

```bash
cd backend
bun test
```

## API Reference

See [backend/README.md](backend/README.md) for API documentation.
