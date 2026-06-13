// This file owns user-visible strings and model-visible crosstalk timeline text.

import type { CrosstalkMessage, PairSide, PairView, UserMessage } from './types';

export const MAX_MESSAGE_LENGTH = 10000;
export const MAX_STATUS_LENGTH = 300;

export const SYSTEM_PROMPT = `<instructions tool="crosstalk">
# Crosstalk

You have a parallel coworker session available through the crosstalk tool.

Use crosstalk when a task can benefit from delegation, a second opinion, or parallel research:
- crosstalk({"action":"send","message":"..."}) sends a full message to your buddy.
- crosstalk({"action":"read"}) reads full messages your buddy sent to you.
- crosstalk({"action":"reply","reply_to":"m1","message":"..."}) replies to a specific message.
- crosstalk({"action":"status"}) checks whether a buddy exists and how many unread messages are waiting.

Your buddy is another OpenCode session with the same agent and model. The buddy is created automatically the first time you send or reply. If you are notified that crosstalk has unread messages, call crosstalk({"action":"read"}) before continuing.
</instructions>`;

export const CROSSTALK_DESCRIPTION =
  'Send messages to, read from, or reply to your paired crosstalk buddy session.';

export const CROSSTALK_USAGE =
  'Usage: /crosstalk. The crosstalk tool is always available; a buddy session is created on first send or reply.';
export const MISSING_MESSAGE = "Error: 'message' parameter is required for send or reply.";
export const UNKNOWN_REPLY = 'Error: Unknown reply target. Use crosstalk read to see message IDs.';
export const NO_PAIR = 'No crosstalk buddy exists yet. Send a message with the crosstalk tool to create one.';

export function normalizeMessage(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}... [truncated]`;
}

function sideName(side: PairSide): string {
  return side === 'source' ? 'main session' : 'buddy session';
}

export function commandStatus(view: PairView): string {
  if (!view.pair || !view.self || !view.buddy || !view.selfSide) {
    return [NO_PAIR, '', 'The crosstalk tool is available in this session.'].join('\n');
  }

  return [
    `Crosstalk pair: ${view.pair.id}`,
    `You are: ${sideName(view.selfSide)} (${view.self.sessionId})`,
    `Buddy: ${sideName(view.buddy.side)} (${view.buddy.sessionId}, ${view.buddy.status})`,
    `Unread messages: ${view.unread.length}`,
  ].join('\n');
}

export function statusResult(view: PairView): string {
  return commandStatus(view);
}

export function sendResult(messageId: string, buddySessionId: string): string {
  return [`Sent crosstalk message ${messageId}.`, `Buddy session: ${buddySessionId}`].join('\n');
}

export function readResult(view: PairView, limit: number): string {
  if (!view.pair || !view.self) {
    return NO_PAIR;
  }

  const visible = view.messages.filter((message) => message.toSessionId === view.self?.sessionId).slice(-limit);
  if (visible.length === 0) {
    return 'No crosstalk messages yet.';
  }

  const lines = ['Crosstalk messages:'];
  for (const message of visible) {
    const label = message.replyTo ? ` reply to ${message.replyTo}` : '';
    lines.push(`- ${message.id} from ${sideName(message.fromSide)}${label}:`);
    lines.push(message.body);
  }
  return lines.join('\n');
}

export function wakePrompt(sender: PairSide): string {
  return `[Crosstalk] New message from your ${sideName(sender)}. Please call crosstalk({"action":"read"}) to read and respond.`;
}

export function buddyBootstrapPrompt(): string {
  return [
    '[Crosstalk] You are the buddy session in a paired crosstalk workflow.',
    'A coworker session may delegate work, ask questions, or request review through the crosstalk tool.',
    'When prompted about new crosstalk messages, call crosstalk({"action":"read"}) to read the full message body and reply if useful.',
  ].join('\n');
}

export function createTimelineMessages(sessionId: string, messages: CrosstalkMessage[], lastUser: UserMessage): UserMessage[] {
  const visible = messages.filter((message) => message.fromSessionId === sessionId || message.toSessionId === sessionId);
  return visible.map((message) => {
    const inbound = message.toSessionId === sessionId;
    const label = inbound ? 'Buddy sent a crosstalk message' : 'You sent a crosstalk message to your buddy';
    const reply = message.replyTo ? ` in reply to ${message.replyTo}` : '';
    const text = inbound
      ? `${label} (${message.id}${reply}). Use crosstalk({"action":"read"}) to read the full message body if needed.`
      : `${label} (${message.id}${reply}).`;
    const messageID = `msg_crosstalk_${message.pairId}_${message.sequence}_${sessionId}`;

    return {
      info: {
        ...lastUser.info,
        id: messageID,
        sessionID: sessionId,
        role: 'user',
        time: { created: message.createdAt, completed: message.createdAt },
      },
      parts: [
        {
          id: `part_crosstalk_${message.pairId}_${message.sequence}_${sessionId}`,
          sessionID: sessionId,
          messageID,
          type: 'text',
          synthetic: true,
          text: `<crosstalk>${text}</crosstalk>`,
        },
      ],
    };
  });
}
