// This file owns user-visible strings and model-visible crosstalk timeline text.

import type { CrosstalkMessage, PairSide, PairView, UserMessage } from './types';

export const MAX_MESSAGE_LENGTH = 10000;
export const MAX_STATUS_LENGTH = 300;
export const MAX_LABEL_LENGTH = 120;

export const SYSTEM_PROMPT = `<instructions tool="crosstalk">
# Crosstalk

You have a parallel coworker session available through the crosstalk tool. Treat it like a second working thread: if you are the user's right arm, the buddy is the left arm. You should strongly consider using it whenever work can proceed in parallel.

Think strategically as a two-person team of capable, cooperative peers. Before and during substantial work, ask yourself: "What can I do while the buddy does something else useful?" Divide work deliberately so both sessions can make progress without stepping on each other.

Use crosstalk proactively when a task can benefit from delegation, a second opinion, independent research, review, or splitting work while you continue your own part:
- crosstalk({"action":"send","label":"short task label","message":"..."}) sends a full message to your buddy.
- crosstalk({"action":"read"}) reads full messages your buddy sent to you.
- crosstalk({"action":"reply","reply_to":"m1","label":"short result label","message":"..."}) replies to a specific message.
- crosstalk({"action":"status"}) checks whether a buddy exists and how many unread messages are waiting.

Coordinate with the buddy like a real coworker, friend, and equal. Give it clear, non-conflicting sub-tasks; keep doing useful main-session work while it runs; read its replies when notified; then fold useful results back into your own work or delegate more follow-up work if there is still parallelizable work left.

Do not assume the buddy has your full conversation context. When you send or reply, include enough context for the buddy to succeed: the user goal, relevant decisions already made, current files or commands involved, constraints, what you are doing in the main session, what you want the buddy to do, and what kind of result you need back. If the buddy already has context from earlier crosstalk messages, reference that explicitly instead of repeating everything.

Do not poll the buddy. After sending work, do not run sleep/wait commands, repeated status/read checks, ping loops, or lookup loops just to see if the buddy is done. Keep working on your own useful tasks. Only wait for the buddy if you are completely blocked and have nothing else useful to do.

Your buddy is another OpenCode session with the same agent and model. The buddy is created automatically the first time you send or reply. If you are notified that crosstalk has unread messages, call crosstalk({"action":"read"}) before continuing.
</instructions>`;

export const CROSSTALK_DESCRIPTION =
  'Coordinate with your paired crosstalk buddy session as a true parallel coworker: strategically split work, give enough context for non-conflicting sub-tasks, keep doing your own useful work, and do not poll/wait for the buddy unless you are completely blocked.';
export const CROSSTALK_COMMAND_DESCRIPTION = 'Show crosstalk buddy status';
export const ACTION_ARG_DESCRIPTION = 'One of: send, read, reply, status';
export const MESSAGE_ARG_DESCRIPTION = 'Message body for send or reply';
export const LABEL_ARG_DESCRIPTION = 'Short label for the delegated task or reply, shown in crosstalk history';
export const REPLY_TO_ARG_DESCRIPTION = 'Message id to reply to, like m1';
export const LIMIT_ARG_DESCRIPTION = 'Maximum messages to read, default 20';

export const CROSSTALK_USAGE =
  'Usage: /crosstalk. The crosstalk tool is always available; a buddy session is created on first send or reply.';
export const INVALID_ACTION = 'Error: action must be one of send, read, reply, status.';
export const MISSING_MESSAGE = "Error: 'message' parameter is required for send or reply.";
export const UNKNOWN_REPLY = 'Error: Unknown reply target. Use crosstalk read to see message IDs.';
export const TARGET_DELETED =
  'Error: crosstalk buddy session was deleted. Existing crosstalk history is still available with read/status, but new messages cannot be delivered to that session.';
export const NOT_PAIRED = 'Error: crosstalk buddy is not paired.';
export const NO_PAIR = 'No crosstalk buddy exists yet. Send a message with the crosstalk tool to create one.';

export function buddyTitle(sessionId: string): string {
  return `crosstalk buddy for ${sessionId}`;
}

export function normalizeMessage(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}... [truncated]`;
}

export function normalizeLabel(label: string | undefined, fallback: string): string {
  const value = (label || '').trim() || fallback;
  if (value.length <= MAX_LABEL_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_LABEL_LENGTH)}... [truncated]`;
}

function sideName(side: PairSide): string {
  return side === 'source' ? 'main session' : 'buddy session';
}

export function crosstalkMessageLabel(fromSide: PairSide, toSide: PairSide, replyTo?: string): string {
  const reply = replyTo ? ` reply to ${replyTo}` : '';
  return `${sideName(fromSide)} -> ${sideName(toSide)}${reply}`;
}

function endpointStatus(endpoint: PairView['self']): string {
  if (!endpoint) {
    return 'unknown';
  }
  return endpoint.deletedAt ? `deleted at ${new Date(endpoint.deletedAt).toISOString()}` : endpoint.status;
}

export function commandStatus(view: PairView): string {
  if (!view.pair || !view.self || !view.buddy || !view.selfSide) {
    return [NO_PAIR, '', 'The crosstalk tool is available in this session.'].join('\n');
  }

  return [
    `Crosstalk pair: ${view.pair.id}`,
    `You are: ${sideName(view.selfSide)} (${view.self.sessionId})`,
    `Buddy: ${sideName(view.buddy.side)} (${view.buddy.sessionId}, ${endpointStatus(view.buddy)})`,
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
    lines.push(`- ${message.id} ${message.label || crosstalkMessageLabel(message.fromSide, message.toSide, message.replyTo)}:`);
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
    'Treat the main session as your parallel coworker. It may delegate research, implementation, review, or follow-up work while it continues its own track.',
    'When prompted about new crosstalk messages, call crosstalk({"action":"read"}) to read the full message body, do the requested non-conflicting work, and reply with concise findings or results.',
  ].join('\n');
}

export function createTimelineMessages(sessionId: string, messages: CrosstalkMessage[], lastUser: UserMessage): UserMessage[] {
  const visible = messages.filter((message) => message.fromSessionId === sessionId || message.toSessionId === sessionId);
  return visible.map((message) => {
    const inbound = message.toSessionId === sessionId;
    const label = inbound ? 'Buddy sent a crosstalk message' : 'You sent a crosstalk message to your buddy';
    const reply = message.replyTo ? ` in reply to ${message.replyTo}` : '';
    const subject = message.label ? `: ${message.label}` : '';
    const text = inbound
      ? `${label} (${message.id}${reply})${subject}. Use crosstalk({"action":"read"}) to read the full message body if needed.`
      : `${label} (${message.id}${reply})${subject}.`;
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
