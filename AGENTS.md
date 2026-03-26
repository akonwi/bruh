# AGENTS.md

Guidance for coding agents working in this repository.

## 1) Project context

Bruh is a Cloudflare-based personal AI agent platform with:
- `edge/`: Worker + Durable Objects + agent runtime
- `web/`: React SPA (Vite + shadcn/base UI)

Primary UX model:
- Main thread at `/`
- Side threads at `/threads/:id`
- No separate threads index page (thread navigation is in the sidebar)

## 2) Philosophy (non-negotiable)

- **Do not take shortcuts that create avoidable tech debt.**
- Optimize for **maintainability and approachability** for the next person working in this codebase.
- Prefer clear, boring, well-structured code over cleverness.
- When choosing between “fast now” and “easy to maintain later,” prefer long-term maintainability unless the user explicitly asks otherwise.
- Leave code in a state where another engineer can quickly understand intent, trace behavior, and safely modify it.

## 3) Repository layout

- `edge/` — Cloudflare Worker, API routes, agent logic, tools, schedules
- `web/` — frontend app, chat UI, sidebar/thread navigation
- `docs/` — architecture and memory conventions
- `README.md` — local setup, env, deploy flow

Read first for architectural context:
- `README.md`
- `docs/decisions.md`
- `docs/memory.md`

## 4) Required workflow for changes

1. **Read before edit**
   - Understand surrounding code and existing patterns before touching files.
2. **Keep edits surgical**
   - Avoid broad rewrites unless explicitly requested.
3. **Stay in scope**
   - Implement only what was asked.
4. **Validate locally** (minimum)
   - `bun run typecheck`
   - `bun run lint` (Biome)
   - For UI changes: run `bun run dev:web` and sanity check relevant views.
   - For edge/tooling changes: run `bun run dev:edge` and verify impacted route/tool behavior.
5. **Report clearly**
   - What changed
   - What validation ran
   - Risks / follow-ups

## 5) Commands

From repo root:
- `bun run dev` — run edge + web
- `bun run dev:web` — web only
- `bun run dev:edge` — edge only
- `bun run typecheck` — typecheck all workspaces
- `bun run lint` — run Biome lint checks
- `bun run format` — run Biome formatter (`--write`)
- `bun run check:biome` — Biome lint alias
- `bun run check:biome:full` — Biome full check (lint + formatting/import diagnostics)
- `bun run deploy:edge` — build web, copy to `edge/public`, deploy worker

## 6) Frontend conventions (`web/`)

- Use existing shadcn/base UI components before custom markup.
- Prefer semantic utility classes and existing component variants.
- Follow existing sidebar patterns (`SidebarMenu`, `SidebarMenuSub`, etc.) when adding nested nav.
- Keep route handling consistent with current union route model in `web/src/App.tsx`.
- Preserve chat/session behavior:
  - `main` thread maps to `/`
  - side threads map to `/threads/:sessionId`

## 7) Edge conventions (`edge/`)

- Prefer explicit errors over silent failures in tools/schedules.
- For tool failures intended to surface in AI SDK tool UI, throw proper tool errors so failed tool calls render as error states.
- Keep schedule and session behavior backward compatible unless requested.
- Avoid changing env var names or deploy assumptions without explicit approval.

## 8) shadcn / component management

If UI primitives need updating, use CLI (do not hand-copy from docs):
- `npx shadcn@latest info`
- `npx shadcn@latest docs <component>`
- `npx shadcn@latest add <component>`

Project is configured for:
- style: `base-lyra`
- base: `base`
- icon library: `phosphor`

## 9) Git and commits

- Prefer small, focused commits.
- Use clear conventional-style messages when possible, e.g.:
  - `feat: ...`
  - `fix: ...`
  - `refactor: ...`
- Do not amend or rewrite history unless explicitly asked.

## 10) Don’ts

- Don’t introduce unrelated refactors.
- Don’t replace established patterns with new abstractions unless requested.
- Don’t skip validation when touching behavior-critical paths (chat, tools, routing, schedules).

## 11) If uncertain

Ask before proceeding when requirements are ambiguous, especially around:
- route model changes
- data/schema migrations
- deploy/runtime behavior
- component library upgrades
