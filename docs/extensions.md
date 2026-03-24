# Web UI Extensions

> **Status:** Design proposal — not yet implemented.

## Goal

The agent should be able to extend the web UI to fit its needs. Extensions are source files the agent creates, and Vite's HMR makes them appear live. On reload, the updated UX persists because the changes are real code on disk.

## Architecture

### Convention-based discovery

Extensions live in `web/src/extensions/`. Each extension is a directory with an `index.tsx` that exports a component and metadata.

```
web/src/extensions/
  file-viewer/
    index.tsx
  deploy-status/
    index.tsx
```

The app discovers extensions at build/HMR time via `import.meta.glob`:

```tsx
const modules = import.meta.glob('./extensions/*/index.tsx', { eager: true })
```

No manifest file to maintain. The agent adds a directory, Vite picks it up, the UI updates.

### Extension shape

Each extension exports a metadata object and a default component:

```tsx
// web/src/extensions/file-viewer/index.tsx
import { File } from '@phosphor-icons/react'

export const extension = {
  id: 'file-viewer',
  title: 'Files',
  icon: File,
  location: 'sidebar', // 'sidebar' | 'panel' | 'overlay'
}

export default function FileViewer() {
  return <div>...</div>
}
```

- **`id`** — Unique key, used for routing and state.
- **`title`** — Display name in the sidebar or panel header.
- **`icon`** — Phosphor icon component.
- **`location`** — Where the extension renders:
  - `sidebar` — Full page accessible from the sidebar nav.
  - `panel` — Side panel alongside the chat transcript.
  - `overlay` — Modal/sheet overlay.

### What the core app provides

Extensions get access to app state and actions via a shared React context:

```tsx
const { session, events, sendPrompt, sessions } = useApp()
```

This gives extensions read access to the current session, event stream, session list, and the ability to send prompts or trigger actions.

Extensions also have access to the full shadcn component library already installed in the project.

### What the agent can do

- **Add a view** — Create a directory in `extensions/`, export a component. It appears in the sidebar and renders in the main area.
- **Add a panel** — Same pattern, with `location: 'panel'`. Renders alongside the chat.
- **Modify an extension** — Edit the files it previously created. HMR updates the UI live.
- **Remove an extension** — Delete the directory.
- **All changes survive reload** — They're real source files, not runtime state.

## Design decisions (open)

### Core file access

Should the agent also modify core files (`App.tsx`, `app-sidebar.tsx`, etc.) or only work within `extensions/`?

- **Extensions only** — Safer, predictable structure, easy to reason about what the agent changed.
- **Full access** — More powerful, but risks breaking the app shell.

Starting with extensions only is the conservative choice. The agent can always be given broader access later.

### Layout slots

Beyond sidebar pages, extensions may want to inject into specific spots:

- Toolbar above the composer
- Status bar at the bottom
- Side panel next to the transcript
- Custom event renderers in the transcript

A slot-based system would let extensions target these areas without modifying core layout files.

### Custom event rendering

The agent emits events through the existing event stream. Extensions could register renderers for custom event types (e.g., `agent.file.changed` renders as a diff card instead of plain text). This would make the transcript richer without changing `buildTranscript`.

### State persistence

Some extensions may need persistent state (settings, cached data). Options:

- `localStorage` scoped by extension ID
- A shared key-value store exposed via `useApp()`
- Files on disk that the agent manages

## Implementation plan (when ready)

1. Create `web/src/extensions/` directory with a `.gitkeep`.
2. Add glob-based discovery in the app shell.
3. Create `useApp()` context with session/events/actions.
4. Auto-register `location: 'sidebar'` extensions as sidebar nav items.
5. Build a sample extension to validate the pattern.
6. Document the extension API for the agent's system prompt so it knows how to create extensions.
