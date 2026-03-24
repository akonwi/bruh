import type { SessionIndexEntry } from './session';

interface RegisterSessionRequest {
  sessionId?: string;
  createdAt?: string;
}

const SESSIONS_KEY = 'sessions';

export class SessionIndexDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (`${request.method} ${url.pathname}`) {
      case 'POST /register':
        return this.handleRegister(request);
      case 'GET /sessions':
        return this.handleList();
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  private async handleRegister(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as RegisterSessionRequest;
    const sessionId = body.sessionId?.trim();

    if (!sessionId) {
      return Response.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const sessions = await this.getSessions();
    if (!sessions.some((session) => session.sessionId === sessionId)) {
      sessions.push({
        sessionId,
        createdAt: body.createdAt?.trim() || new Date().toISOString(),
      });
      await this.saveSessions(sessions);
    }

    return Response.json({ ok: true, sessionId });
  }

  private async handleList(): Promise<Response> {
    const sessions = await this.getSessions();
    sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Response.json({ sessions });
  }

  private async getSessions(): Promise<SessionIndexEntry[]> {
    return (await this.state.storage.get<SessionIndexEntry[]>(SESSIONS_KEY)) ?? [];
  }

  private async saveSessions(sessions: SessionIndexEntry[]): Promise<void> {
    await this.state.storage.put(SESSIONS_KEY, sessions);
  }
}
