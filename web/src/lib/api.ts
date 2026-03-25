export interface SessionState {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  latestSeq: number;
  status: 'idle' | 'active';
  title?: string;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? '/api' : '');

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export async function createSession(): Promise<SessionState> {
  const response = await fetch(apiUrl('/sessions'), { method: 'POST' });
  if (!response.ok) throw new Error(`Failed to create session: ${response.status}`);
  return response.json();
}

export async function getMainSession(): Promise<SessionState> {
  const response = await fetch(apiUrl('/main-session'));
  if (!response.ok) throw new Error(`Failed to load main session: ${response.status}`);
  return response.json();
}

export async function listSessions(): Promise<SessionState[]> {
  const response = await fetch(apiUrl('/sessions'));
  if (!response.ok) throw new Error(`Failed to list sessions: ${response.status}`);
  const data = (await response.json()) as { sessions?: SessionState[] };
  return data.sessions ?? [];
}

export async function getSession(sessionId: string): Promise<SessionState> {
  const response = await fetch(apiUrl(`/sessions/${sessionId}`));
  if (!response.ok) throw new Error(`Failed to load session: ${response.status}`);
  return response.json();
}
