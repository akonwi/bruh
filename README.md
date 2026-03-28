# Bruh

A personal AI agent platform on Cloudflare.

## What it is

Bruh is a single-user AI agent with:
- A persistent **main thread** at `/` — your ongoing conversation
- **Side threads** at `/threads/:id` for focused work
- **Durable memory** in R2 shared across all threads
- **Sandbox containers** for code execution, git, and filesystem operations
- **MCP client** for connecting to external tool servers
- **Scheduling** — one-time and recurring tasks that the agent executes autonomously
- Multi-provider support (**Anthropic** and **OpenAI**)

## Architecture

Everything runs on Cloudflare:

```
Browser (useAgentChat via WebSocket)
  → Edge Worker (Hono routes + routeAgentRequest)
    → BruhAgent DO (AIChatAgent + AI SDK v6 streamText)
      → Anthropic / OpenAI (based on env keys)
      → R2 (memory tools)
      → Sandbox containers (bash, git, python, node)
      → MCP servers (auto-exposed tools + OAuth)
      → SQLite (messages, schedules, state)
```

| Component | What | Where |
|---|---|---|
| `edge/` | Worker + BruhAgent DO + Sandbox DO | Cloudflare Workers |
| `web/` | React SPA (shadcn/ui) | Built and served from edge |
| R2 | Durable memory (profile, notes, projects, summaries) | `bruh-memory` bucket |
| SQLite | Messages, thread registry, schedules | In each DO instance |

## Tools

| Category | Tools |
|---|---|
| Memory | `memory_read`, `memory_write`, `memory_edit`, `memory_append`, `memory_list` |
| Sandbox | `sandbox_exec`, `sandbox_read`, `sandbox_write`, `sandbox_list`, `sandbox_git_clone` |
| Scheduling | `schedule_once`, `schedule_recurring`, `schedule_list`, `schedule_cancel` |
| Threads | `thread_list`, `thread_summary` |
| MCP | `mcp_connect`, `mcp_disconnect`, `mcp_servers`, `mcp_tools` + auto-exposed server tools |

## Local development

```bash
# Install dependencies
bun install

# Create edge/.dev.vars from the example
cp edge/.dev.vars.example edge/.dev.vars
# Fill in at least ANTHROPIC_API_KEY or OPENAI_API_KEY

# Start both edge worker and web dev server
bun run dev
```

Edge runs on `http://localhost:8790`, web on `http://localhost:5173`.

If you are working on Sandbox behavior locally, see [Local Sandbox development](./docs/local-sandbox.md) for the current known-good baseline on Apple Silicon and the fallback troubleshooting steps we have validated.

### Environment variables (edge/.dev.vars)

```bash
# At least one required
ANTHROPIC_API_KEY=your-key
# OPENAI_API_KEY=your-key

# For MCP OAuth callbacks
HOST=http://localhost:8790
APP_ORIGIN=http://localhost:5173

# Auto-connects GitHub MCP server if set
# GITHUB_MCP_TOKEN=ghp_your-token
```

## Deployment

```bash
bun run deploy:edge
```

This builds the web app, copies it to `edge/public/`, and deploys the Worker.

### Secrets

```bash
cd edge
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GITHUB_MCP_TOKEN
npx wrangler secret put HOST
# Value: https://bruh-edge.akonwi.workers.dev
```

## Scripts

```bash
bun run dev          # start edge + web
bun run dev:edge     # edge worker only
bun run dev:web      # web dev server only
bun run typecheck    # typecheck both packages
bun run deploy:edge  # build + deploy
```

## Docs

- [Local Sandbox development](./docs/local-sandbox.md) — known-good local baseline and Sandbox troubleshooting notes
- [Memory conventions](./docs/memory.md) — how durable memory is organized
- [Architecture decisions](./docs/decisions.md) — key design choices and rationale

## License

[MIT](./LICENSE.md)
