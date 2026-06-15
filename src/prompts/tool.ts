import type { PairSide } from '../types';

export const MAX_MESSAGE_LENGTH = 10000;
export const MAX_STATUS_LENGTH = 300;
export const MAX_LABEL_LENGTH = 120;

export const CROSSTALK_DESCRIPTION =
  'Coordinate with your paired crosstalk buddy session only when it materially helps: split substantial non-conflicting work into main and buddy tracks, request independent review or research, send self-contained context-rich handoffs with priority order, keep doing your own useful work, and do not use crosstalk for small/local tasks or poll/wait for the buddy unless completely blocked.';
export const CROSSTALK_COMMAND_DESCRIPTION = 'Show crosstalk buddy status';
export const ACTION_ARG_DESCRIPTION =
  'Required action. Use send to delegate work, read to fetch full buddy messages, reply to answer a specific message, or status to inspect the pair and optionally update your status label.';
export const MESSAGE_ARG_DESCRIPTION =
  'Message body for send or reply. Include enough context, goal, constraints, ownership boundaries, priority order, and requested result for the buddy to work independently and report useful partial progress on longer tasks.';
export const LABEL_ARG_DESCRIPTION =
  'Use this for send/reply/status: a short label like "upstream research", "test review", "implementation pass", "risk check", or "still reviewing failing tests". For status, this becomes your visible current status label. Shown in crosstalk history, status, and timeline markers.';
export const REPLY_TO_ARG_DESCRIPTION = 'Message id to reply to, like m1';
export const LIMIT_ARG_DESCRIPTION = 'Maximum messages to read, default 20';

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

export function sideName(side: PairSide): string {
  return side === 'source' ? 'main session' : 'buddy session';
}

export function crosstalkMessageLabel(fromSide: PairSide, toSide: PairSide, replyTo?: string): string {
  const reply = replyTo ? ` reply to ${replyTo}` : '';
  return `${sideName(fromSide)} -> ${sideName(toSide)}${reply}`;
}
