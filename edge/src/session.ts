export type SessionStatus = 'idle' | 'active';

export interface SessionMetadata {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  latestSeq: number;
  status: SessionStatus;
  title?: string;
}

export interface SessionEventEnvelope {
  sessionId: string;
  seq: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SessionPromptRequest {
  text: string;
}

export interface Env {
  SESSION_DO: DurableObjectNamespace;
}
