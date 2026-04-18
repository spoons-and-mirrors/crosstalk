// This file owns the user-visible strings and synthetic prompt content for crosstalk.

import type { HandledMessage, SharedMessage, SharedSession, UserMessage } from './types';

const DEFAULT_MODEL_ID = 'unknown';
const DEFAULT_PROVIDER_ID = 'unknown';

export const MAX_MESSAGE_LENGTH = 10000;
export const MAX_STATUS_LENGTH = 300;
export const DEFAULT_ROOM = 'default';

export const SYSTEM_PROMPT = `<instructions tool="crosstalk">
# Crosstalk

You are joined to a shared crosstalk room.

Use \`broadcast\` to communicate with other joined sessions:
- \`broadcast(message="...")\` updates your visible status
- \`broadcast(send_to="name", message="...")\` sends a direct message
- \`broadcast(reply_to=1, message="...")\` replies to a received message and automatically targets the sender

Messages arrive as a synthetic \`broadcast\` tool result with this shape:
\`\`\`
{
  "you_are": "your registered name",
  "sessions": [{ "name": "other", "status": ["..."], "idle": true }],
  "messages": [{ "id": 1, "from": "other", "content": "..." }]
}
\`\`\`

When you receive a direct message, answer with \`broadcast(reply_to=<id>, message="...")\` or send a new direct message with \`send_to\`.
</instructions>`;

export const BROADCAST_DESCRIPTION =
  "Communicate with other joined crosstalk sessions. Omit send_to for a status update, use send_to for a direct message, or use reply_to to answer a received message.";

export const JOIN_USAGE =
  'Usage: /crosstalk join [--room ROOM] [name...] | /crosstalk status | /crosstalk inbox | /crosstalk drop';
export const NOT_JOINED = "This session is not joined. Use /crosstalk join first.";
export const SELF_MESSAGE = "Warning: You cannot send a message to yourself.";
export const MISSING_MESSAGE = "Error: 'message' parameter is required.";
export const UNKNOWN_REPLY = "Error: Unknown reply target.";

function peerLines(peers: SharedSession[]): string[] {
  if (peers.length === 0) {
    return ['No other joined sessions yet.'];
  }

  const lines = ['Other joined sessions:'];
  for (const peer of peers) {
    const state = peer.status === 'idle' ? 'idle' : 'busy';
    lines.push(`- ${peer.alias} (${state})`);
    for (const status of peer.history) {
      lines.push(`  -> ${status}`);
    }
  }

  return lines;
}

export function joinResult(self: string, room: string, peers: SharedSession[], messages: SharedMessage[]): string {
  const lines = [`Joined crosstalk room ${room} as ${self}.`, '', `Open messages: ${messages.length}`, ''];
  lines.push(...peerLines(peers));
  return lines.join('\n');
}

export function statusResult(self: string, room: string, peers: SharedSession[], messages: SharedMessage[]): string {
  const lines = [`You are: ${self}`, `Room: ${room}`, `Open messages: ${messages.length}`, ''];
  lines.push(...peerLines(peers));
  return lines.join('\n');
}

export function inboxResult(self: string, room: string, messages: SharedMessage[]): string {
  const lines = [`Broadcast inbox for ${self}`, `Room: ${room}`];

  if (messages.length === 0) {
    lines.push('', 'No unread messages.');
    return lines.join('\n');
  }

  lines.push('', 'Open messages:');
  for (const message of messages) {
    lines.push(`- #${message.msgIndex} from ${message.from}: "${message.body}"`);
  }

  return lines.join('\n');
}

export function normalizeMessage(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}... [truncated]`;
}

export function unknownRecipient(name: string, peers: SharedSession[]): string {
  if (peers.length === 0) {
    return `Error: Unknown recipient \"${name}\". No other joined sessions are available.`;
  }

  return `Error: Unknown recipient \"${name}\". Known sessions: ${peers.map((peer) => peer.alias).join(', ')}`;
}

export function broadcastResult(
  self: string,
  peers: SharedSession[],
  recipients: string[],
  handled?: HandledMessage,
): string {
  const lines = [`You are: ${self}`];

  if (peers.length === 0) {
    lines.push('', 'No other joined sessions available.');
  }

  if (peers.length > 0) {
    lines.push('', 'Available sessions:');
    for (const peer of peers) {
      const state = peer.status === 'idle' ? 'idle' : 'busy';
      lines.push(`- ${peer.alias} (${state})`);
      for (const status of peer.history) {
        lines.push(`  -> ${status}`);
      }
    }
  }

  if (handled) {
    lines.push('', `Replied to #${handled.id} from ${handled.from}:`, `"${handled.body}"`);
    if (recipients.length > 0) {
      lines.push('', `Message sent to: ${recipients.join(', ')}`);
    }
    return lines.join('\n');
  }

  if (recipients.length > 0) {
    lines.push('', `Message sent to: ${recipients.join(', ')}`);
    return lines.join('\n');
  }

  lines.push('', 'Status updated.');
  return lines.join('\n');
}

export function wakePrompt(sender: string): string {
  return `[Crosstalk] New message from ${sender}. Check your broadcast inbox and reply there.`;
}

export function createInboxMessage(
  sessionId: string,
  alias: string,
  peers: SharedSession[],
  messages: SharedMessage[],
  lastUser: UserMessage,
): Record<string, unknown> {
  const now = Date.now();
  const info = lastUser.info;
  const output = JSON.stringify({
    you_are: alias,
    sessions: peers.map((peer) => ({
      name: peer.alias,
      status: peer.history.length > 0 ? peer.history : undefined,
      idle: peer.status === 'idle' || undefined,
    })),
    messages: messages.map((message) => ({
      id: message.msgIndex,
      from: message.from,
      content: message.body,
    })),
  });

  const messageId = `msg_crosstalk_${now}`;
  const partId = `part_crosstalk_${now}`;
  const callId = `call_crosstalk_${now}`;
  const title = messages.length > 0 ? `${messages.length} message(s)` : 'Crosstalk inbox';
  const assistant: Record<string, unknown> = {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: 'assistant',
      agent: info.agent || 'code',
      parentID: info.id,
      modelID: info.model?.modelID || DEFAULT_MODEL_ID,
      providerID: info.model?.providerID || DEFAULT_PROVIDER_ID,
      mode: 'default',
      path: { cwd: '/', root: '/' },
      time: { created: now, completed: now },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      ...(info.variant !== undefined ? { variant: info.variant } : {}),
    },
    parts: [
      {
        id: partId,
        sessionID: sessionId,
        messageID: messageId,
        type: 'tool',
        callID: callId,
        tool: 'broadcast',
        state: {
          status: 'completed',
          input: { synthetic: true },
          output,
          title,
          metadata: {
            incoming_message: messages.length > 0,
            message_count: messages.length,
            session_count: peers.length,
          },
          time: { start: now, end: now },
        },
      },
    ],
  };

  return assistant;
}
