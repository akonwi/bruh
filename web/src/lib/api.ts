export interface SessionState {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  latestSeq: number;
  status: 'idle' | 'active';
  title?: string;
}

export interface SessionEventEnvelope {
  sessionId: string;
  seq: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? '/api' : '');
const RUNTIME_API_BASE =
  import.meta.env.VITE_RUNTIME_API_BASE ?? (import.meta.env.DEV ? '/runtime-api' : API_BASE);

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function runtimeApiUrl(path: string): string {
  return `${RUNTIME_API_BASE}${path}`;
}

export async function createSession(): Promise<SessionState> {
  const response = await fetch(apiUrl('/sessions'), { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`);
  }
  return response.json();
}

export async function listSessions(): Promise<SessionState[]> {
  const response = await fetch(apiUrl('/sessions'));
  if (!response.ok) {
    throw new Error(`Failed to list sessions: ${response.status}`);
  }

  const data = (await response.json()) as { sessions?: SessionState[] };
  return data.sessions ?? [];
}

export async function getSession(sessionId: string): Promise<SessionState> {
  const response = await fetch(apiUrl(`/sessions/${sessionId}`));
  if (!response.ok) {
    throw new Error(`Failed to load session: ${response.status}`);
  }
  return response.json();
}

export async function sendPrompt(sessionId: string, text: string): Promise<void> {
  const targetPath = import.meta.env.DEV
    ? runtimeApiUrl(`/internal/sessions/${sessionId}/prompt`)
    : apiUrl(`/sessions/${sessionId}/prompt`)

  const response = await fetch(targetPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`Failed to send prompt: ${response.status}`);
  }
}

export async function abortSession(sessionId: string): Promise<void> {
  const targetPath = import.meta.env.DEV
    ? runtimeApiUrl(`/internal/sessions/${sessionId}/abort`)
    : apiUrl(`/sessions/${sessionId}/abort`)

  const response = await fetch(targetPath, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Failed to abort prompt: ${response.status}`);
  }
}

export async function getSessionEvents(sessionId: string, after = 0): Promise<SessionEventEnvelope[]> {
  const url = new URL(apiUrl(`/sessions/${sessionId}/events`), window.location.origin);
  if (after > 0) url.searchParams.set('after', String(after));

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to load session events: ${response.status}`);
  }

  const data = (await response.json()) as { events?: SessionEventEnvelope[] };
  return data.events ?? [];
}

export function createSessionStream(sessionId: string, after = 0): EventSource {
  const url = new URL(apiUrl(`/sessions/${sessionId}/stream`), window.location.origin);
  if (after > 0) url.searchParams.set('after', String(after));
  return new EventSource(url.toString());
}
