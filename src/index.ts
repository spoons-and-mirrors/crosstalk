// This file wires the crosstalk plugin together: command handling, prompt injection, broadcast, and wake-ups.

import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import {
  BROADCAST_DESCRIPTION,
  MISSING_MESSAGE,
  NOT_JOINED,
  SELF_MESSAGE,
  SYSTEM_PROMPT,
  UNKNOWN_REPLY,
  broadcastResult,
  createInboxMessage,
  normalizeMessage,
  unknownRecipient,
  wakePrompt,
} from './prompts';
import {
  dropRoom,
  getRoomView,
  handleReply,
  joinRoom,
  markPresented,
  sendMessage,
  syncLocalSessions,
  updateStatus,
} from './room';
import type {
  CommandInput,
  CommandOutput,
  ConfigTransformOutput,
  LocalSession,
  MessagesTransformOutput,
  OpenCodeSessionClient,
  SessionDeletedInput,
  SessionIdleInput,
  SessionStatusInput,
  SystemTransformInput,
  SystemTransformOutput,
  ToolContext,
} from './types';

const POLL_INTERVAL_MS = 1500;

const joined = new Map<string, LocalSession>();
const waking = new Set<string>();
let poller: ReturnType<typeof setInterval> | undefined;
let storedClient: OpenCodeSessionClient | undefined;

function wakeKey(sessionId: string, msgIndex: number): string {
  return `${sessionId}:${msgIndex}`;
}

function ensurePoller(client: OpenCodeSessionClient): void {
  storedClient = client;
  if (poller) {
    return;
  }

  poller = setInterval(() => {
    void poll();
  }, POLL_INTERVAL_MS);
  poller.unref?.();
}

async function readSessionModel(client: OpenCodeSessionClient, sessionId: string) {
  const messages = (await client.session.messages({ path: { id: sessionId } })).data || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.info.role !== 'user') {
      continue;
    }
    if (!message.info.agent && !message.info.model) {
      continue;
    }
    return {
      agent: message.info.agent,
      model: message.info.model
        ? {
            providerID: message.info.model.providerID,
            modelID: message.info.model.modelID,
          }
        : undefined,
    };
  }
  return {};
}

async function wakeSession(client: OpenCodeSessionClient, sessionId: string, from: string): Promise<void> {
  const model = await readSessionModel(client, sessionId);
  const send = client.session.promptAsync || client.session.prompt;
  await send({
    path: { id: sessionId },
    body: {
      parts: [{ type: 'text', text: wakePrompt(from) }],
      agent: model.agent,
      model: model.model,
    },
  });
}

async function poll(): Promise<void> {
  if (!storedClient) {
    return;
  }

  if (joined.size === 0) {
    return;
  }

  const wake = await syncLocalSessions(joined);
  for (const candidate of wake) {
    const pending = candidate.msgIndices.filter((msgIndex) => !waking.has(wakeKey(candidate.sessionId, msgIndex)));
    if (pending.length === 0) {
      continue;
    }

    for (const msgIndex of pending) {
      waking.add(wakeKey(candidate.sessionId, msgIndex));
    }

    try {
      await wakeSession(storedClient, candidate.sessionId, candidate.from);
      await markPresented(candidate.sessionId, pending);
    } finally {
      for (const msgIndex of pending) {
        waking.delete(wakeKey(candidate.sessionId, msgIndex));
      }
    }
  }
}

function parseCommand(input: string): { action?: 'join' | 'drop'; name?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  if (trimmed === 'drop') {
    return { action: 'drop' };
  }

  if (trimmed === 'join') {
    return { action: 'join' };
  }

  if (trimmed.startsWith('join ')) {
    return { action: 'join', name: trimmed.slice(5) };
  }

  return {};
}

function commandText(text: string) {
  return [{ type: 'text', text }];
}

function setJoined(sessionId: string, alias: string): void {
  const current = joined.get(sessionId);
  joined.set(sessionId, {
    alias,
    status: current?.status || 'idle',
  });
}

function createBroadcastTool() {
  return tool({
    description: BROADCAST_DESCRIPTION,
    args: {
      send_to: tool.schema.string().optional().describe('Target session name. Omit to publish a status update.'),
      message: tool.schema.string().describe('Message or status text'),
      reply_to: tool.schema.number().optional().describe('Reply to an inbox message by numeric id'),
    },
    async execute(args, context: ToolContext) {
      const view = await getRoomView(context.sessionID);
      if (!view.self) {
        return NOT_JOINED;
      }

      const body = normalizeMessage(args.message || '', 10000);
      if (!body) {
        return MISSING_MESSAGE;
      }

      const handled = args.reply_to !== undefined ? await handleReply(context.sessionID, args.reply_to) : undefined;
      if (args.reply_to !== undefined && !handled) {
        return UNKNOWN_REPLY;
      }

      const autoRecipient = handled?.from;
      const target = autoRecipient || args.send_to?.trim();

      if (!target) {
        const next = await updateStatus(context.sessionID, body);
        return broadcastResult(next.self?.alias || view.self.alias, next.peers, [], handled);
      }

      if (target.toLowerCase() === view.self.alias.toLowerCase()) {
        return SELF_MESSAGE;
      }

      const sent = await sendMessage(context.sessionID, target, body);
      if (sent.error === 'not-joined' || !sent.self) {
        return NOT_JOINED;
      }
      if (sent.error === 'self') {
        return SELF_MESSAGE;
      }
      if (sent.error === 'unknown-recipient') {
        return unknownRecipient(target, sent.peers);
      }
      return broadcastResult(sent.self.alias, sent.peers, sent.sentTo ? [sent.sentTo] : [], handled);
    },
  });
}

const plugin: Plugin = async (ctx) => {
  const client = ctx.client as unknown as OpenCodeSessionClient;
  ensurePoller(client);

  return {
    tool: {
      broadcast: createBroadcastTool(),
    },

    config: async (input: ConfigTransformOutput) => {
      input.command ??= {};
      input.command.crosstalk = {
        description: 'Join or leave the crosstalk room',
        template: '$ARGUMENTS',
      };

      const experimental = input.experimental || {};
      const tools = new Set(experimental.subagent_tools || []);
      tools.add('broadcast');
      input.experimental = {
        ...experimental,
        subagent_tools: [...tools],
      };
    },

    'command.execute.before': async (input: CommandInput, output: CommandOutput) => {
      if (input.command !== 'crosstalk') {
        return;
      }

      output.parts.length = 0;
      const parsed = parseCommand(input.arguments);
      if (parsed.action === 'join') {
        const alias = await joinRoom(input.sessionID, parsed.name);
        setJoined(input.sessionID, alias);
        await poll();
        output.parts.push(...commandText(`Joined crosstalk as ${alias}.`));
        return;
      }

      if (parsed.action === 'drop') {
        joined.delete(input.sessionID);
        await dropRoom(input.sessionID);
        output.parts.push(...commandText('Dropped from crosstalk.'));
        return;
      }

      output.parts.push(...commandText('Usage: /crosstalk join [name...] or /crosstalk drop'));
    },

    'experimental.chat.system.transform': async (
      input: SystemTransformInput,
      output: SystemTransformOutput,
    ) => {
      if (!input.sessionID) {
        return;
      }

      const view = await getRoomView(input.sessionID);
      if (!view.self) {
        return;
      }

      output.system.push(SYSTEM_PROMPT);
    },

    'experimental.chat.messages.transform': async (_input: unknown, output: MessagesTransformOutput) => {
      const lastUser = [...output.messages].reverse().find((message) => message.info.role === 'user');
      if (!lastUser) {
        return;
      }

      const view = await getRoomView(lastUser.info.sessionID);
      if (!view.self) {
        return;
      }

      output.messages.push(
        createInboxMessage(lastUser.info.sessionID, view.self.alias, view.peers, view.messages, lastUser) as never,
      );

      if (view.messages.length === 0) {
        return;
      }

      await markPresented(
        lastUser.info.sessionID,
        view.messages.map((message) => message.msgIndex),
      );
    },

    'session.status': async (input: SessionStatusInput) => {
      const local = joined.get(input.sessionID);
      if (!local) {
        return;
      }

      joined.set(input.sessionID, {
        alias: local.alias,
        status: input.status.type === 'idle' ? 'idle' : 'busy',
      });
      await poll();
    },

    'session.idle': async (input: SessionIdleInput) => {
      const local = joined.get(input.sessionID);
      if (!local) {
        return;
      }

      joined.set(input.sessionID, {
        alias: local.alias,
        status: 'idle',
      });
      await poll();
    },

    'session.deleted': async (input: SessionDeletedInput) => {
      if (!joined.has(input.sessionID)) {
        return;
      }

      joined.delete(input.sessionID);
      await dropRoom(input.sessionID);
    },
  };
};

export default plugin;

export function __resetForTests(): void {
  joined.clear();
  waking.clear();
  storedClient = undefined;
  if (!poller) {
    return;
  }
  clearInterval(poller);
  poller = undefined;
}
