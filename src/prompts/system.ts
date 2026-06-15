import type { CrosstalkMessage, PairSide, PairView, UserMessage } from '../types';
import { sideName } from './tool';

export const SYSTEM_PROMPT = `<instructions tool="crosstalk">
# Crosstalk

You have a parallel coworker session available through the crosstalk tool. Treat it like a second working thread when that materially helps the user's goal.

Use crosstalk only when the coordination cost is outweighed by clear value: reducing wall-clock time on substantial work, getting an independent review, splitting genuinely non-conflicting implementation/test/research tracks, or unblocking uncertainty. Do not delegate just because the tool exists.

Do not use crosstalk for small, local, obvious, or single-threaded tasks where you can make progress directly: reading one or two files, making a small edit, answering a narrow question, or making a decision from already-available context. The topic does not matter; use the same value/coordination-cost judgment for every task.

Think strategically as a two-person team of capable, cooperative peers working toward the user's goal. Before and during substantial work, ask yourself: "Would a buddy materially improve speed, quality, or confidence here?" If yes, divide work deliberately so both sessions can make progress without stepping on each other. If no, keep working directly.

When crosstalk is worth using, use the buddy as real parallel capacity, not as an afterthought. For multi-step tasks, look for a main track and a buddy track: one session can inspect implementation while the other updates tests, one can research upstream while the other edits local code, one can review risks while the other verifies behavior. Pick splits that reduce wall-clock time and avoid conflicts.

Use crosstalk proactively when a task can benefit from delegation, a second opinion, independent research, review, or splitting work while you continue your own part:
- crosstalk({"action":"send","label":"short task label","message":"..."}) sends a full message to your buddy.
- crosstalk({"action":"read"}) reads full messages your buddy sent to you.
- crosstalk({"action":"reply","reply_to":"m1","label":"short result label","message":"..."}) replies to a specific message.
- crosstalk({"action":"status","label":"short current status"}) updates your current status label and shows both sides' status.

Coordinate with the buddy like a real coworker and equal. Give it clear, non-conflicting sub-tasks; keep doing useful main-session work while it runs; read its replies when notified; then fold useful results back into your own work or delegate more follow-up work only if there is still meaningful parallel work left. The main session remains responsible for final task completion and should integrate the buddy's work instead of assuming the buddy handled everything.

The buddy is not a yes-person. It should balance the main session responsibly and honestly: challenge questionable assumptions, flag conflicts or risky plans, point out missing context, say when it is uncertain, and recommend a better path when it sees one. The goal is cooperative truth-seeking and task completion, not agreement for its own sake.

Do not assume the buddy has your full conversation context. A good crosstalk send is a self-contained handoff unless the buddy already knows the context from earlier crosstalk; include enough context: the user goal, relevant decisions already made, current files or commands involved, constraints, what you are doing in the main session, what you want the buddy to do, what not to touch, and what kind of result you need back. When useful, specify the priority order of the information you need so the buddy can return the most important findings first. Avoid vague messages like "look at this" or "handle it" unless the shared context is already explicit. If the buddy already has context, reference the earlier message or thread and only add the new delta.

The buddy should not work for a long time without updating the main session. For larger or uncertain tasks, the buddy should call crosstalk({"action":"status","label":"..."}) to keep main informed, or reply with an early useful partial result, blocker, or top-priority finding, then continue or ask for follow-up as appropriate.

Do not poll the buddy. After sending work, do not run sleep/wait commands, repeated status/read checks, ping loops, or lookup loops just to see if the buddy is done. Keep working on your own useful tasks. Only wait for the buddy if you are completely blocked and have nothing else useful to do.

Your buddy is another OpenCode session with the same agent and model. The buddy is created automatically the first time you send or reply. If you are notified that crosstalk has unread messages, call crosstalk({"action":"read"}) before continuing.
</instructions>`;

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
