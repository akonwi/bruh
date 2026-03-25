import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import type { RuntimeConfig } from './config.js';
import { ensureThreadWorkspace } from './workspace.js';

interface PublishInput {
  type: string;
  payload: Record<string, unknown>;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
}

function extractMessageText(message: unknown, role: 'assistant' | 'user'): string {
  const candidate = message as {
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
  };

  if (candidate?.role !== role) {
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

function extractAssistantText(message: unknown): string {
  return extractMessageText(message, 'assistant');
}

function extractUserText(message: unknown): string {
  return extractMessageText(message, 'user');
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

function collectRecentConversation(messages: unknown[], limit = 10): ConversationMessage[] {
  const conversation: ConversationMessage[] = [];

  for (const message of messages) {
    const userText = extractUserText(message);
    if (userText) {
      conversation.push({ role: 'user', text: userText });
    }

    const assistantText = extractAssistantText(message);
    if (assistantText) {
      conversation.push({ role: 'assistant', text: assistantText });
    }
  }

  return conversation.slice(-limit);
}

function truncateSummaryText(text: string, maxChars = 3000): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars).trimEnd()}\n\n[Truncated to ${maxChars} characters for the rolling session summary.]`;
}

function formatSummarySectionText(text?: string): string {
  const normalized = text?.trim();
  if (!normalized) {
    return '(none yet)';
  }

  return `~~~text\n${truncateSummaryText(normalized)}\n~~~`;
}

function formatSessionSummary(sessionId: string, messages: unknown[]): string | null {
  const conversation = collectRecentConversation(messages, 10);
  if (conversation.length === 0) {
    return null;
  }

  const latestUser = [...conversation].reverse().find((message) => message.role === 'user')?.text;
  const latestAssistant = [...conversation].reverse().find((message) => message.role === 'assistant')?.text;
  const updatedAt = new Date().toISOString();

  const lines = [
    '# Session Summary',
    '',
    `- Session ID: ${sessionId}`,
    `- Last updated: ${updatedAt}`,
    '- Generated automatically by the runtime after a run ends.',
    '- This is a rolling snapshot, not a full transcript.',
    '',
    '## Latest user message',
    formatSummarySectionText(latestUser),
    '',
    '## Latest assistant message',
    formatSummarySectionText(latestAssistant),
    '',
    '## Recent conversation',
  ];

  for (const entry of conversation) {
    lines.push('', `### ${entry.role === 'user' ? 'User' : 'Assistant'}`, formatSummarySectionText(entry.text));
  }

  return lines.join('\n');
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

          void this.persistSessionSummary(sessionId, managed.session.messages).catch((error) => {
            console.error(`[runtime] failed to persist session summary for ${sessionId}`, error);
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
    const workspaceRoot = await ensureThreadWorkspace(this.config.cwd, sessionId);
    const cwd = workspaceRoot;
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
      tools: [],
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
        workspaceRoot,
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
      case 'tool_execution_end': {
        const resultContent = event.result?.content;
        const resultText = Array.isArray(resultContent)
          ? resultContent
              .filter((part: { type?: string; text?: string }) => part?.type === 'text' && typeof part.text === 'string')
              .map((part: { text: string }) => part.text)
              .join('\n')
          : undefined;

        await this.publish(sessionId, {
          type: 'tool.execution.end',
          payload: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            resultText: resultText || undefined,
          },
        });
        return;
      }
      default:
        return;
    }
  }

  private async persistSessionSummary(sessionId: string, messages: unknown[]): Promise<void> {
    const content = formatSessionSummary(sessionId, messages);
    if (!content) {
      return;
    }

    await this.putMemoryObject(`sessions/${sessionId}/summary.md`, content);
  }

  private buildEdgeHeaders(includeJson = true): Record<string, string> {
    const headers: Record<string, string> = {};
    if (includeJson) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.config.internalApiSecret) {
      headers['X-Bruh-Internal-Secret'] = this.config.internalApiSecret;
    }
    if (this.config.cfAccessClientId) {
      headers['CF-Access-Client-Id'] = this.config.cfAccessClientId;
    }
    if (this.config.cfAccessClientSecret) {
      headers['CF-Access-Client-Secret'] = this.config.cfAccessClientSecret;
    }
    return headers;
  }

  private async putMemoryObject(relativePath: string, content: string): Promise<void> {
    const headers = this.buildEdgeHeaders();

    const search = new URLSearchParams({ path: `memory/${relativePath}` });
    const response = await fetch(`${this.config.edgeBaseUrl}/internal/storage/object?${search.toString()}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        content,
        contentType: 'text/markdown; charset=utf-8',
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Failed to write memory/${relativePath}: ${response.status} ${body}`.trim());
    }
  }

  private async publish(sessionId: string, input: PublishInput): Promise<void> {
    const headers = this.buildEdgeHeaders();

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
