// This file exposes the crosstalk server plugin and wires the paired buddy tool, timeline projection, and wake-ups.

import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import {
  CROSSTALK_DESCRIPTION,
  CROSSTALK_COMMAND_DESCRIPTION,
  CROSSTALK_USAGE,
  ACTION_ARG_DESCRIPTION,
  INVALID_ACTION,
  LABEL_ARG_DESCRIPTION,
  LIMIT_ARG_DESCRIPTION,
  MESSAGE_ARG_DESCRIPTION,
  MISSING_MESSAGE,
  NOT_PAIRED,
  REPLY_TO_ARG_DESCRIPTION,
  SYSTEM_PROMPT,
  TARGET_DELETED,
  UNKNOWN_REPLY,
  buddyBootstrapPrompt,
  buddyTitle,
  commandStatus,
  createBuddyAfkMessage,
  createTimelineMessages,
  readResult,
  sendResult,
  statusResult,
  wakePrompt,
} from './prompts';
import { addMessage, createPair, getPairView, markWake, readMessages, removeSession, syncLocalSessions, updateStatusLabel } from './room';
import type {
  CommandInput,
  ConfigTransformOutput,
  MessagesTransformOutput,
  OpenCodeSessionClient,
  PluginEvent,
  SessionDeletedInput,
  SessionIdleInput,
  SessionStatusInput,
  SystemTransformInput,
  SystemTransformOutput,
  ToolContext,
  UserMessage,
} from './types';
import { buddyIdleFetches, getClient, getPoller, localSessions, setClient, setPoller, waking } from './memory';

const POLL_INTERVAL_MS = 1500;
const COMMAND_HANDLED = '__CROSSTALK_COMMAND_HANDLED__';
const DEFAULT_READ_LIMIT = 20;
const BUDDY_AFK_FETCH_THRESHOLD = 10;

function wakeKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`;
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
            modelID: message.info.model.modelID || message.info.model.id,
            variant: message.info.variant || message.info.model.variant,
          }
        : undefined,
    };
  }
  return {};
}

async function promptNoReply(client: OpenCodeSessionClient, sessionId: string, text: string): Promise<void> {
  await client.session.prompt({
    path: { id: sessionId },
    body: {
      noReply: true,
      parts: [{ type: 'text', text }],
    },
  });
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

async function ensurePair(client: OpenCodeSessionClient, sessionId: string) {
  const existing = await getPairView(sessionId);
  if (existing.pair && existing.buddy) {
    localSessions.set(existing.self?.sessionId || sessionId, { status: existing.self?.status || 'idle' });
    localSessions.set(existing.buddy.sessionId, { status: existing.buddy.status });
    return existing;
  }

  if (!client.session.create) {
    throw new Error('This OpenCode client does not expose session.create, so crosstalk cannot create a buddy session.');
  }

  const model = await readSessionModel(client, sessionId);
  const created = await client.session.create({
    body: {
      title: buddyTitle(sessionId),
      agent: model.agent,
      model: model.model
        ? {
            providerID: model.model.providerID,
            id: model.model.modelID,
            variant: typeof model.model.variant === 'string' ? model.model.variant : undefined,
          }
        : undefined,
    },
  });
  const buddySessionId = created.data?.id;
  if (!buddySessionId) {
    throw new Error('OpenCode did not return a buddy session id.');
  }

  const view = await createPair({
    sourceSessionId: sessionId,
    buddySessionId,
    agent: model.agent,
    model: model.model,
  });
  localSessions.set(sessionId, { status: view.self?.status || 'idle' });
  localSessions.set(buddySessionId, { status: view.buddy?.status || 'idle' });
  await promptNoReply(client, buddySessionId, buddyBootstrapPrompt());
  return view;
}

async function wakeSession(client: OpenCodeSessionClient, sessionId: string, fromSide: 'source' | 'buddy'): Promise<void> {
  const model = await readSessionModel(client, sessionId);
  const body = {
    parts: [{ type: 'text', text: wakePrompt(fromSide) }],
    agent: model.agent,
    model: model.model,
  };

  if (client.session.promptAsync) {
    await client.session.promptAsync({ path: { id: sessionId }, body });
    return;
  }

  await client.session.prompt({ path: { id: sessionId }, body });
}

async function poll(): Promise<void> {
  const client = getClient();
  if (!client || localSessions.size === 0) {
    return;
  }

  const wake = await syncLocalSessions(localSessions);
  for (const candidate of wake) {
    const pending = candidate.messageIds.filter((messageId) => !waking.has(wakeKey(candidate.sessionId, messageId)));
    if (pending.length === 0) {
      continue;
    }

    for (const messageId of pending) {
      waking.add(wakeKey(candidate.sessionId, messageId));
    }

    try {
      await markWake(candidate.sessionId, pending);
      await wakeSession(client, candidate.sessionId, candidate.fromSide);
    } finally {
      for (const messageId of pending) {
        waking.delete(wakeKey(candidate.sessionId, messageId));
      }
    }
  }
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

function insertTimeline(messages: UserMessage[], timeline: UserMessage[], lastUser: UserMessage): void {
  if (timeline.length === 0) {
    return;
  }

  const existing = new Set(messages.map((message) => message.info.id));
  const fresh = timeline.filter((message) => !existing.has(message.info.id));
  if (fresh.length === 0) {
    return;
  }

  for (const message of fresh) {
    const lastUserIndex = messages.findIndex((candidate) => candidate.info.id === lastUser.info.id);
    const lastUserCreated = lastUser.info.time?.created || 0;
    const created = message.info.time?.created || 0;
    const insertionLimit = lastUserIndex === -1 || created > lastUserCreated ? messages.length : lastUserIndex;
    let index = messages.findIndex((candidate, candidateIndex) => {
      if (candidateIndex >= insertionLimit) {
        return false;
      }
      return (candidate.info.time?.created || 0) > created;
    });
    if (index === -1) {
      index = insertionLimit;
    }
    messages.splice(index, 0, message);
  }
}

function resetBuddyIdleFetches(pairId: string | undefined): void {
  if (pairId) {
    buddyIdleFetches.delete(pairId);
  }
}

function maybeCreateBuddyAfkMessage(sessionId: string, view: Awaited<ReturnType<typeof getPairView>>, lastUser: UserMessage): UserMessage | undefined {
  if (!view.pair || view.selfSide !== 'source' || !view.buddy || view.buddy.deletedAt) {
    resetBuddyIdleFetches(view.pair?.id);
    return undefined;
  }

  if (view.buddy.status !== 'idle' || view.unread.length > 0) {
    resetBuddyIdleFetches(view.pair.id);
    return undefined;
  }

  const idleFetches = (buddyIdleFetches.get(view.pair.id) || 0) + 1;
  buddyIdleFetches.set(view.pair.id, idleFetches);
  if (idleFetches < BUDDY_AFK_FETCH_THRESHOLD) {
    return undefined;
  }

  return createBuddyAfkMessage(sessionId, view, idleFetches, lastUser);
}

function createCrosstalkTool(client: OpenCodeSessionClient) {
  return tool({
    description: CROSSTALK_DESCRIPTION,
    args: {
      action: tool.schema.string().describe(ACTION_ARG_DESCRIPTION),
      message: tool.schema.string().optional().describe(MESSAGE_ARG_DESCRIPTION),
      label: tool.schema.string().optional().describe(LABEL_ARG_DESCRIPTION),
      reply_to: tool.schema.string().optional().describe(REPLY_TO_ARG_DESCRIPTION),
      limit: tool.schema.number().optional().describe(LIMIT_ARG_DESCRIPTION),
    },
    async execute(args, context: ToolContext) {
      const action = (args.action || 'status').trim().toLowerCase();

      if (action === 'status') {
        const label = typeof args.label === 'string' ? args.label : '';
        return statusResult(label.trim() ? await updateStatusLabel(context.sessionID, label) : await getPairView(context.sessionID));
      }

      if (action === 'read') {
        const limit = Math.max(1, Math.min(Number(args.limit) || DEFAULT_READ_LIMIT, 100));
        return readResult(await readMessages(context.sessionID, limit), limit);
      }

      if (action !== 'send' && action !== 'reply') {
        return INVALID_ACTION;
      }

      const body = typeof args.message === 'string' ? args.message : '';
      if (!body.trim()) {
        return MISSING_MESSAGE;
      }

      const view = await ensurePair(client, context.sessionID);
      const label = typeof args.label === 'string' ? args.label : undefined;
      const sent = await addMessage(context.sessionID, body, action === 'reply' ? args.reply_to : undefined, label);
      if (sent.error === 'unknown-reply') {
        return UNKNOWN_REPLY;
      }
      if (sent.error === 'empty') {
        return MISSING_MESSAGE;
      }
      if (sent.error === 'target-deleted') {
        return TARGET_DELETED;
      }
      if (sent.error === 'not-paired' || !sent.message) {
        return NOT_PAIRED;
      }
      resetBuddyIdleFetches(sent.message.pairId);

      const targetSessionId = sent.message.toSessionId;
      const local = localSessions.get(targetSessionId);
      if (local?.status === 'idle') {
        await poll();
      }

      return sendResult(sent.message.id, view.buddy?.sessionId || targetSessionId);
    },
  });
}

const server: Plugin = async (ctx) => {
  const client = ctx.client as unknown as OpenCodeSessionClient;
  ensurePoller(client);

  return {
    tool: {
      crosstalk: createCrosstalkTool(client),
    },

    config: async (input: ConfigTransformOutput) => {
      input.command ??= {};
      input.command.crosstalk = {
        description: CROSSTALK_COMMAND_DESCRIPTION,
        template: '$ARGUMENTS',
      };

      const experimental = input.experimental || {};
      const tools = new Set(experimental.subagent_tools || []);
      tools.add('crosstalk');
      input.experimental = {
        ...experimental,
        subagent_tools: [...tools],
      };
    },

    'command.execute.before': async (input: CommandInput) => {
      if (input.command !== 'crosstalk') {
        return;
      }

      const view = await getPairView(input.sessionID);
      await sendIgnoredMessage(client, input.sessionID, input.arguments.trim() ? CROSSTALK_USAGE : commandStatus(view));
      throw new Error(COMMAND_HANDLED);
    },

    'experimental.chat.system.transform': async (input: SystemTransformInput, output: SystemTransformOutput) => {
      if (!input.sessionID) {
        return;
      }

      output.system.push(SYSTEM_PROMPT);
    },

    'experimental.chat.messages.transform': async (_input: unknown, output: MessagesTransformOutput) => {
      const lastUser = [...output.messages].reverse().find((message) => message.info.role === 'user');
      if (!lastUser) {
        return;
      }

      const view = await getPairView(lastUser.info.sessionID);
      if (!view.pair) {
        return;
      }

      insertTimeline(
        output.messages,
        createTimelineMessages(lastUser.info.sessionID, view.messages, lastUser),
        lastUser,
      );
      const afk = maybeCreateBuddyAfkMessage(lastUser.info.sessionID, view, lastUser);
      if (afk) {
        output.messages.push(afk);
      }
    },

    event: async ({ event }) => {
      const status = statusEvent(event as PluginEvent);
      if (status) {
        const local = localSessions.get(status.sessionID);
        if (!local) {
          return;
        }

        localSessions.set(status.sessionID, {
          status: status.status.type === 'idle' ? 'idle' : 'busy',
        });
        await poll();
        return;
      }

      const idle = idleEvent(event as PluginEvent);
      if (idle) {
        const local = localSessions.get(idle.sessionID);
        if (!local) {
          return;
        }

        localSessions.set(idle.sessionID, { status: 'idle' });
        await poll();
        return;
      }

      const deleted = deletedEvent(event as PluginEvent);
      if (!deleted) {
        return;
      }

      localSessions.delete(deleted.sessionID);
      await removeSession(deleted.sessionID);
    },
  };
};

const plugin: PluginModule = {
  id: 'crosstalk',
  server,
};

export default plugin;
