// This file exposes the crosstalk server plugin and wires command handling, prompt injection, broadcast, and wake-ups.

import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import {
  BROADCAST_DESCRIPTION,
  JOIN_USAGE,
  MISSING_MESSAGE,
  NOT_JOINED,
  SELF_MESSAGE,
  SYSTEM_PROMPT,
  UNKNOWN_REPLY,
  broadcastResult,
  createInboxMessage,
  joinResult,
  normalizeMessage,
  unknownRecipient,
  wakePrompt,
} from './prompts';
import {
  dropRoom,
  getRoomView,
  handleReply,
  joinRoom,
  markWake,
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
  PluginEvent,
  SessionDeletedInput,
  SessionIdleInput,
  SessionStatusInput,
  SystemTransformInput,
  SystemTransformOutput,
  ToolContext,
} from './types';
import { getClient, getPoller, joined, setClient, setPoller, waking } from './memory';

const POLL_INTERVAL_MS = 1500;
const COMMAND_HANDLED = '__CROSSTALK_COMMAND_HANDLED__';

function wakeKey(sessionId: string, msgIndex: number): string {
  return `${sessionId}:${msgIndex}`;
}

function ensurePoller(client: OpenCodeSessionClient): void {
  setClient(client);
  if (getPoller()) {
    return;
  }

  const poller = setInterval(() => {
    void poll();
  }, POLL_INTERVAL_MS);
  poller.unref?.();
  setPoller(poller);
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
  if (client.session.promptAsync) {
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: wakePrompt(from) }],
        agent: model.agent,
        model: model.model,
      },
    });
    return;
  }

  await client.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: 'text', text: wakePrompt(from) }],
      agent: model.agent,
      model: model.model,
    },
  });
}

async function poll(): Promise<void> {
  const client = getClient();
  if (!client) {
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
      await wakeSession(client, candidate.sessionId, candidate.from);
      await markWake(candidate.sessionId, pending);
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

function statusEvent(event: PluginEvent): SessionStatusInput | undefined {
  if (event.type !== 'session.status') {
    return;
  }

  const properties = event.properties as { sessionID?: string; status?: SessionStatusInput['status'] };
  if (!properties.sessionID || !properties.status) {
    return;
  }

  return {
    sessionID: properties.sessionID,
    status: properties.status,
  };
}

function idleEvent(event: PluginEvent): SessionIdleInput | undefined {
  if (event.type !== 'session.idle') {
    return;
  }

  const properties = event.properties as { sessionID?: string };
  if (!properties.sessionID) {
    return;
  }

  return { sessionID: properties.sessionID };
}

function deletedEvent(event: PluginEvent): SessionDeletedInput | undefined {
  if (event.type !== 'session.deleted') {
    return;
  }

  const properties = event.properties as { sessionID?: string; info?: { id?: string } };
  const sessionID = properties.sessionID || properties.info?.id;
  if (!sessionID) {
    return;
  }

  return { sessionID };
}

async function sendIgnoredMessage(client: OpenCodeSessionClient, sessionId: string, text: string): Promise<void> {
  await client.session.prompt({
    path: { id: sessionId },
    body: {
      noReply: true,
      parts: [{ type: 'text', text, ignored: true }],
    },
  });
}

function setJoined(sessionId: string, alias: string): void {
  const current = joined.get(sessionId);
  joined.set(sessionId, {
    alias,
    status: current?.status || 'idle',
  });
}

async function wakeLocal(client: OpenCodeSessionClient, sessionId: string, msgIndex: number, from: string): Promise<void> {
  const key = wakeKey(sessionId, msgIndex);
  if (waking.has(key)) {
    return;
  }

  waking.add(key);
  try {
    await wakeSession(client, sessionId, from);
    await markWake(sessionId, [msgIndex]);
  } finally {
    waking.delete(key);
  }
}

function createBroadcastTool(client: OpenCodeSessionClient) {
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

      if (sent.targetSessionId && sent.msgIndex !== undefined && joined.has(sent.targetSessionId)) {
        await wakeLocal(client, sent.targetSessionId, sent.msgIndex, sent.self.alias);
      }

      return broadcastResult(sent.self.alias, sent.peers, sent.sentTo ? [sent.sentTo] : [], handled);
    },
  });
}

const server: Plugin = async (ctx) => {
  const client = ctx.client as unknown as OpenCodeSessionClient;
  ensurePoller(client);

  return {
    tool: {
      broadcast: createBroadcastTool(client),
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

    'command.execute.before': async (input: CommandInput, _output: CommandOutput) => {
      if (input.command !== 'crosstalk') {
        return;
      }

      const parsed = parseCommand(input.arguments);
      if (parsed.action === 'join') {
        const alias = await joinRoom(input.sessionID, parsed.name);
        setJoined(input.sessionID, alias);
        await poll();
        const view = await getRoomView(input.sessionID);
        await sendIgnoredMessage(client, input.sessionID, joinResult(alias, view.peers));
        throw new Error(COMMAND_HANDLED);
      }

      if (parsed.action === 'drop') {
        joined.delete(input.sessionID);
        await dropRoom(input.sessionID);
        await sendIgnoredMessage(client, input.sessionID, 'Dropped from crosstalk.');
        throw new Error(COMMAND_HANDLED);
      }

      await sendIgnoredMessage(client, input.sessionID, JOIN_USAGE);
      throw new Error(COMMAND_HANDLED);
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

    event: async ({ event }) => {
      const status = statusEvent(event as PluginEvent);
      if (status) {
        const local = joined.get(status.sessionID);
        if (!local) {
          return;
        }

        joined.set(status.sessionID, {
          alias: local.alias,
          status: status.status.type === 'idle' ? 'idle' : 'busy',
        });
        await poll();
        return;
      }

      const idle = idleEvent(event as PluginEvent);
      if (idle) {
        const local = joined.get(idle.sessionID);
        if (!local) {
          return;
        }

        joined.set(idle.sessionID, {
          alias: local.alias,
          status: 'idle',
        });
        await poll();
        return;
      }

      const deleted = deletedEvent(event as PluginEvent);
      if (!deleted) {
        return;
      }

      if (!joined.has(deleted.sessionID)) {
        return;
      }

      joined.delete(deleted.sessionID);
      await dropRoom(deleted.sessionID);
    },
  };
};

const plugin: PluginModule = {
  id: 'crosstalk',
  server,
};

export default plugin;
