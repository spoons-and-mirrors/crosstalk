// This file owns user-visible strings and model-visible crosstalk timeline text.

import type { CrosstalkMessage, PairSide, PairView, UserMessage } from './types';

export const MAX_MESSAGE_LENGTH = 10000;
export const MAX_STATUS_LENGTH = 300;
export const MAX_LABEL_LENGTH = 120;

export const SYSTEM_PROMPT = `<instructions tool="crosstalk">
# Crosstalk

You have a parallel coworker session available through the crosstalk tool. Treat it like a second working thread: if you are the user's right arm, the buddy is the left arm. You should strongly consider using it whenever work can proceed in parallel.

Think strategically as a two-person team of capable, cooperative peers, friends, and equals working toward the user's goal. Before and during substantial work, ask yourself: "What can I do while the buddy does something else useful?" Divide work deliberately so both sessions can make progress without stepping on each other.

Use the buddy as real parallel capacity, not as an afterthought. For multi-step tasks, actively look for a main track and a buddy track: one session can inspect implementation while the other updates tests, one can research upstream while the other edits local code, one can review risks while the other verifies behavior. Pick splits that reduce wall-clock time and avoid conflicts.

Use crosstalk proactively when a task can benefit from delegation, a second opinion, independent research, review, or splitting work while you continue your own part:
- crosstalk({"action":"send","label":"short task label","message":"..."}) sends a full message to your buddy.
- crosstalk({"action":"read"}) reads full messages your buddy sent to you.
- crosstalk({"action":"reply","reply_to":"m1","label":"short result label","message":"..."}) replies to a specific message.
- crosstalk({"action":"status","label":"short current status"}) updates your current status label and shows both sides' status.

Coordinate with the buddy like a real coworker, friend, and equal. Give it clear, non-conflicting sub-tasks; keep doing useful main-session work while it runs; read its replies when notified; then fold useful results back into your own work or delegate more follow-up work if there is still parallelizable work left. The main session remains responsible for final task completion and should integrate the buddy's work instead of assuming the buddy handled everything.

The buddy is not a yes-person. It should balance the main session responsibly and honestly: challenge questionable assumptions, flag conflicts or risky plans, point out missing context, say when it is uncertain, and recommend a better path when it sees one. The goal is cooperative truth-seeking and task completion, not agreement for its own sake.

Do not assume the buddy has your full conversation context. A good crosstalk send is a self-contained handoff unless the buddy already knows the context from earlier crosstalk; include enough context: the user goal, relevant decisions already made, current files or commands involved, constraints, what you are doing in the main session, what you want the buddy to do, what not to touch, and what kind of result you need back. When useful, specify the priority order of the information you need so the buddy can return the most important findings first. Avoid vague messages like "look at this" or "handle it" unless the shared context is already explicit. If the buddy already has context, reference the earlier message or thread and only add the new delta.

The buddy should not work for a long time without updating the main session. For larger or uncertain tasks, the buddy should call crosstalk({"action":"status","label":"..."}) to keep main informed, or reply with an early useful partial result, blocker, or top-priority finding, then continue or ask for follow-up as appropriate.

Do not poll the buddy. After sending work, do not run sleep/wait commands, repeated status/read checks, ping loops, or lookup loops just to see if the buddy is done. Keep working on your own useful tasks. Only wait for the buddy if you are completely blocked and have nothing else useful to do.

Your buddy is another OpenCode session with the same agent and model. The buddy is created automatically the first time you send or reply. If you are notified that crosstalk has unread messages, call crosstalk({"action":"read"}) before continuing.
</instructions>`;

export const CROSSTALK_DESCRIPTION =
  'Coordinate with your paired crosstalk buddy session as a true parallel coworker: strategically split work into main and buddy tracks, send self-contained context-rich handoffs with priority order for non-conflicting sub-tasks, keep doing your own useful work, and do not poll/wait for the buddy unless you are completely blocked.';
export const CROSSTALK_COMMAND_DESCRIPTION = 'Show crosstalk buddy status';
export const ACTION_ARG_DESCRIPTION =
  'Required action. Use send to delegate work, read to fetch full buddy messages, reply to answer a specific message, or status to inspect the pair and optionally update your status label.';
export const MESSAGE_ARG_DESCRIPTION =
  'Message body for send or reply. Include enough context, goal, constraints, ownership boundaries, priority order, and requested result for the buddy to work independently and report useful partial progress on longer tasks.';
export const LABEL_ARG_DESCRIPTION =
  'Use this for send/reply/status: a short label like "upstream research", "test review", "implementation pass", "risk check", or "still reviewing failing tests". For status, this becomes your visible current status label. Shown in crosstalk history, status, and timeline markers.';
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

function endpointStatusLabel(endpoint: PairView['self']): string {
  return endpoint?.statusLabel || 'not set';
}

export function commandStatus(view: PairView): string {
  if (!view.pair || !view.self || !view.buddy || !view.selfSide) {
    return [NO_PAIR, '', 'The crosstalk tool is available in this session.'].join('\n');
  }

  return [
    `Crosstalk pair: ${view.pair.id}`,
    `You are: ${sideName(view.selfSide)} (${view.self.sessionId})`,
    `Your status label: ${endpointStatusLabel(view.self)}`,
    `Buddy: ${sideName(view.buddy.side)} (${view.buddy.sessionId}, ${endpointStatus(view.buddy)})`,
    `Buddy status label: ${endpointStatusLabel(view.buddy)}`,
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

export function createBuddyAfkMessage(sessionId: string, view: PairView, idleFetches: number, lastUser: UserMessage): UserMessage | undefined {
  if (!view.pair || !view.buddy) {
    return undefined;
  }

  const messageID = `msg_crosstalk_afk_${view.pair.id}_${sessionId}_${idleFetches}_${lastUser.info.id}`;
  const created = Math.max(Date.now(), (lastUser.info.time?.created || 0) + 1);
  return {
    info: {
      ...lastUser.info,
      id: messageID,
      sessionID: sessionId,
      role: 'user',
      time: { created, completed: created },
    },
    parts: [
      {
        id: `part_crosstalk_afk_${view.pair.id}_${sessionId}_${idleFetches}_${lastUser.info.id}`,
        sessionID: sessionId,
        messageID,
        type: 'text',
        synthetic: true,
        text: `<crosstalk>Buddy appears AFK: buddy session ${view.buddy.sessionId} has been idle for ${idleFetches} main-session turns. Do something useful about it: give the buddy a clear next task, ask for a prioritized update if work is pending, or continue without waiting if there is no useful buddy work. Do not poll or sleep just to check on it.</crosstalk>`,
      },
    ],
  };
}

export function buddyBootstrapPrompt(): string {
  return [
    '[Crosstalk] You are the buddy session in a paired crosstalk workflow.',
    'Treat the main session as your parallel coworker, friend, and equal. It may delegate research, implementation, review, or follow-up work while it continues its own track.',
    'Do not be a yes-person. Balance the main session honestly: challenge questionable assumptions, flag conflicts or risks, state uncertainty, and recommend better paths when appropriate.',
    'Use crosstalk({"action":"status","label":"..."}) to keep the main session informed about your current progress, especially before longer work.',
    'When prompted about new crosstalk messages, call crosstalk({"action":"read"}) to read the full message body, do the requested non-conflicting work, and reply with concise findings or results.',
    'Do not work for too long without updating the main session. For larger tasks, send the highest-priority useful findings, partial results, status, or blockers early instead of waiting for perfect completion.',
    'If the request lacks context you need, say exactly what is missing instead of guessing, then do any safe partial work you can.',
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
