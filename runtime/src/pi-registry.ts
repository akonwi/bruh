import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  AuthStorage,
  createAgentSession,
  createReadOnlyTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import type { RuntimeConfig } from './config.js';

interface PublishInput {
  type: string;
  payload: Record<string, unknown>;
}

function extractAssistantText(message: unknown): string {
  const candidate = message as {
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
  };

  if (candidate?.role !== 'assistant') {
    return '';
  }

  if (typeof candidate.content === 'string') {
    return candidate.content;
  }

  if (!Array.isArray(candidate.content)) {
    return '';
  }

  return candidate.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function extractAssistantTextFromMessages(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = extractAssistantText(messages[i]);
    if (text) return text;
  }
  return '';
}

function extractAssistantStopReason(message: unknown): string | undefined {
  const candidate = message as {
    role?: string;
    stopReason?: string;
  };

  if (candidate?.role !== 'assistant' || typeof candidate.stopReason !== 'string') {
    return undefined;
  }

  return candidate.stopReason;
}

function extractAssistantStopReasonFromMessages(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const stopReason = extractAssistantStopReason(messages[i]);
    if (stopReason) return stopReason;
  }
  return undefined;
}

function isAbortLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /abort/i.test(message);
}

interface ManagedSession {
  session: AgentSession;
  queue: Promise<void>;
  isRunning: boolean;
  abortRequested: boolean;
}

export class PiSessionRegistry {
  private sessions = new Map<string, ManagedSession>();

  constructor(private readonly config: RuntimeConfig) {}

  async steer(sessionId: string, text: string): Promise<{ queued: boolean; reason?: string }> {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      return { queued: false, reason: 'not_found' };
    }

    if (!managed.isRunning) {
      return { queued: false, reason: 'idle' };
    }

    try {
      await managed.session.steer(text);
      await this.publish(sessionId, {
        type: 'runtime.steer.queued',
        payload: { text },
      });
      return { queued: true };
    } catch (error) {
      await this.publish(sessionId, {
        type: 'runtime.error',
        payload: {
          message: error instanceof Error ? error.message : 'Unknown runtime error',
        },
      });
      return { queued: false, reason: 'error' };
    }
  }

  async followUp(sessionId: string, text: string): Promise<{ queued: boolean; reason?: string }> {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      return { queued: false, reason: 'not_found' };
    }

    if (!managed.isRunning) {
      return { queued: false, reason: 'idle' };
    }

    try {
      await managed.session.followUp(text);
      await this.publish(sessionId, {
        type: 'runtime.follow_up.queued',
        payload: { text },
      });
      return { queued: true };
    } catch (error) {
      await this.publish(sessionId, {
        type: 'runtime.error',
        payload: {
          message: error instanceof Error ? error.message : 'Unknown runtime error',
        },
      });
      return { queued: false, reason: 'error' };
    }
  }

  async abort(sessionId: string): Promise<{ aborted: boolean; reason?: string }> {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      return { aborted: false, reason: 'not_found' };
    }

    if (!managed.isRunning) {
      return { aborted: false, reason: 'idle' };
    }

    if (managed.abortRequested) {
      return { aborted: true, reason: 'already_requested' };
    }

    managed.abortRequested = true;
    await this.publish(sessionId, {
      type: 'runtime.prompt.abort.requested',
      payload: {},
    });

    try {
      await managed.session.abort();
      return { aborted: true };
    } catch (error) {
      managed.abortRequested = false;
      await this.publish(sessionId, {
        type: 'runtime.error',
        payload: {
          message: error instanceof Error ? error.message : 'Unknown runtime error',
        },
      });
      return { aborted: false, reason: 'error' };
    }
  }

  async enqueuePrompt(sessionId: string, text: string): Promise<void> {
    const managed = await this.getOrCreate(sessionId);

    managed.queue = managed.queue
      .catch(() => undefined)
      .then(async () => {
        managed.isRunning = true;
        managed.abortRequested = false;

        await this.publish(sessionId, {
          type: 'session.status',
          payload: { status: 'active' },
        });
        await this.publish(sessionId, {
          type: 'runtime.prompt.start',
          payload: { text },
        });

        try {
          await managed.session.prompt(text);
        } catch (error) {
          const aborted = managed.abortRequested || isAbortLikeError(error);

          if (!aborted) {
            await this.publish(sessionId, {
              type: 'runtime.error',
              payload: {
                message: error instanceof Error ? error.message : 'Unknown runtime error',
              },
            });
          }
        } finally {
          managed.isRunning = false;
          managed.abortRequested = false;

          await this.publish(sessionId, {
            type: 'session.status',
            payload: { status: 'idle' },
          });
        }
      });
  }

  private async getOrCreate(sessionId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const session = await this.createSession(sessionId);
    const managed: ManagedSession = {
      session,
      queue: Promise.resolve(),
      isRunning: false,
      abortRequested: false,
    };
    this.sessions.set(sessionId, managed);
    return managed;
  }

  private async createSession(sessionId: string): Promise<AgentSession> {
    const cwd = this.config.cwd;
    const agentDir = this.config.agentDir;
    const authPath = path.join(agentDir, 'auth.json');
    await mkdir(agentDir, { recursive: true });

    const authStorage = AuthStorage.create(authPath);
    authStorage.setRuntimeApiKey('anthropic', this.config.anthropicApiKey);

    const modelRegistry = new ModelRegistry(authStorage);
    const availableModels = await modelRegistry.getAvailable();
    const preferredModelIds = [
      this.config.anthropicModel,
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-sonnet-4-20250514',
      'claude-sonnet-4-5',
    ];

    const model =
      preferredModelIds
        .map((modelId) => modelRegistry.find('anthropic', modelId))
        .find((candidate) => candidate && availableModels.some((available) => available.id === candidate.id)) ??
      availableModels.find((candidate) => candidate.provider === 'anthropic' && /opus-4-6|opus-4-5|opus|sonnet-4|sonnet-4-5|sonnet/i.test(candidate.id)) ??
      availableModels.find((candidate) => candidate.provider === 'anthropic');

    if (!model) {
      throw new Error('No Anthropic model is available. Check ANTHROPIC_API_KEY.');
    }

    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: 'minimal',
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
      tools: createReadOnlyTools(cwd),
    });

    session.subscribe((event) => {
      void this.handleAgentEvent(sessionId, event).catch((error) => {
        console.error('[runtime] failed to handle agent event', error);
      });
    });

    await this.publish(sessionId, {
      type: 'runtime.session.ready',
      payload: {
        provider: model.provider,
        modelId: model.id,
        requestedModelId: this.config.anthropicModel,
      },
    });

    return session;
  }

  private async handleAgentEvent(sessionId: string, event: AgentSessionEvent): Promise<void> {
    switch (event.type) {
      case 'agent_start':
        await this.publish(sessionId, { type: 'agent.start', payload: {} });
        return;
      case 'agent_end': {
        const messages = Array.isArray(event.messages) ? event.messages : [];
        const finalText = extractAssistantTextFromMessages(messages);
        const stopReason = extractAssistantStopReasonFromMessages(messages);

        if (stopReason === 'aborted') {
          await this.publish(sessionId, {
            type: 'runtime.prompt.aborted',
            payload: {},
          });
        }

        if (finalText) {
          await this.publish(sessionId, {
            type: 'assistant.agent.complete',
            payload: { text: finalText },
          });
        }

        await this.publish(sessionId, { type: 'agent.end', payload: {} });
        return;
      }
      case 'message_update': {
        const update = event.assistantMessageEvent;
        if (update.type === 'text_delta') {
          await this.publish(sessionId, {
            type: 'assistant.text.delta',
            payload: { delta: update.delta },
          });
        } else if (update.type === 'thinking_delta') {
          await this.publish(sessionId, {
            type: 'assistant.thinking.delta',
            payload: { delta: update.delta },
          });
        }
        return;
      }
      case 'message_end': {
        const text = extractAssistantText(event.message);
        if (text) {
          await this.publish(sessionId, {
            type: 'assistant.message.complete',
            payload: { text },
          });
        }
        return;
      }
      case 'turn_end': {
        const text = extractAssistantText(event.message);
        if (text) {
          await this.publish(sessionId, {
            type: 'assistant.turn.complete',
            payload: { text },
          });
        }
        return;
      }
      case 'tool_execution_start':
        await this.publish(sessionId, {
          type: 'tool.execution.start',
          payload: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          },
        });
        return;
      case 'tool_execution_end':
        await this.publish(sessionId, {
          type: 'tool.execution.end',
          payload: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
          },
        });
        return;
      default:
        return;
    }
  }

  private async publish(sessionId: string, input: PublishInput): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.internalApiSecret) {
      headers['X-Bruh-Internal-Secret'] = this.config.internalApiSecret;
    }

    const response = await fetch(`${this.config.edgeBaseUrl}/internal/sessions/${sessionId}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: input.type,
        payload: input.payload,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Failed to publish event to edge: ${response.status} ${body}`.trim());
    }
  }
}
