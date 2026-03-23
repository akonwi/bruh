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

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export async function createSession(): Promise<SessionState> {
  const response = await fetch(apiUrl('/sessions'), { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`);
  }
  return response.json();
}

export async function getSession(sessionId: string): Promise<SessionState> {
  const response = await fetch(apiUrl(`/sessions/${sessionId}`));
  if (!response.ok) {
    throw new Error(`Failed to load session: ${response.status}`);
  }
  return response.json();
}

export async function sendPrompt(sessionId: string, text: string): Promise<void> {
  const response = await fetch(apiUrl(`/sessions/${sessionId}/prompt`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`Failed to send prompt: ${response.status}`);
  }
}

export function createSessionStream(sessionId: string, after = 0): EventSource {
  const url = new URL(apiUrl(`/sessions/${sessionId}/stream`), window.location.origin);
  if (after > 0) url.searchParams.set('after', String(after));
  return new EventSource(url.toString());
}
