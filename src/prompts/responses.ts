import type { PairView } from '../types';
import { crosstalkMessageLabel, sideName } from './tool';

export const CROSSTALK_USAGE =
  'Usage: /crosstalk. The crosstalk tool is always available; a buddy session is created on first send or reply.';
export const INVALID_ACTION = 'Error: action must be one of send, read, reply, status.';
export const MISSING_MESSAGE = "Error: 'message' parameter is required for send or reply.";
export const UNKNOWN_REPLY = 'Error: Unknown reply target. Use crosstalk read to see message IDs.';
export const TARGET_DELETED =
  'Error: crosstalk buddy session was deleted. Existing crosstalk history is still available with read/status, but new messages cannot be delivered to that session.';
export const NOT_PAIRED = 'Error: crosstalk buddy is not paired.';
export const NO_PAIR = 'No crosstalk buddy exists yet. Send a message with the crosstalk tool to create one.';

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
