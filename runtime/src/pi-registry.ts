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

interface ManagedSession {
  session: AgentSession;
  queue: Promise<void>;
}

export class PiSessionRegistry {
  private sessions = new Map<string, ManagedSession>();

  constructor(private readonly config: RuntimeConfig) {}

  async enqueuePrompt(sessionId: string, text: string): Promise<void> {
    const managed = await this.getOrCreate(sessionId);

    managed.queue = managed.queue
      .catch(() => undefined)
      .then(async () => {
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
          await this.publish(sessionId, {
            type: 'runtime.error',
            payload: {
              message: error instanceof Error ? error.message : 'Unknown runtime error',
            },
          });
        } finally {
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
    const model =
      availableModels.find((candidate) => candidate.provider === 'anthropic' && /sonnet/i.test(candidate.id)) ??
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

        await this.publish(sessionId, {
          type: 'runtime.debug.agent_end',
          payload: {
            messageCount: messages.length,
            roles: messages.map((message) => {
              const candidate = message as { role?: string };
              return candidate.role ?? 'unknown';
            }),
            hasFinalText: Boolean(finalText),
          },
        });

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
            toolName: event.toolName,
            args: event.args,
          },
        });
        return;
      case 'tool_execution_end':
        await this.publish(sessionId, {
          type: 'tool.execution.end',
          payload: {
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
    const response = await fetch(`${this.config.edgeBaseUrl}/internal/sessions/${sessionId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
