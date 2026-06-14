// This file is the single source of truth for crosstalk pair state stored on disk.

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  CrosstalkMessage,
  CrosstalkPair,
  CrosstalkState,
  LocalSession,
  ModelRef,
  PairEndpoint,
  PairSide,
  PairView,
  WakeCandidate,
} from './types';
import { MAX_MESSAGE_LENGTH, crosstalkMessageLabel, normalizeMessage } from './prompts';

const LOCK_STALE_MS = 10000;
const LOCK_RETRY_MS = 50;
const MESSAGE_TTL_MS = 12 * 60 * 60 * 1000;
const WAKE_RETRY_MS = 5000;

function stateDir(): string {
  return process.env.OPENCODE_CROSSTALK_DIR || path.join(process.env.HOME || '', '.local', 'state', 'opencode-crosstalk');
}

function stateFile(): string {
  return path.join(stateDir(), 'state.json');
}

function lockDir(): string {
  return path.join(stateDir(), 'state.lock');
}

function emptyState(): CrosstalkState {
  return {
    version: 2,
    pairs: {},
    messages: [],
  };
}

function now(): number {
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

async function quarantineStateFile(): Promise<void> {
  const suffix = `${Date.now()}.${process.pid}`;
  await fs.rename(stateFile(), path.join(stateDir(), `state.corrupt.${suffix}.json`)).catch(() => undefined);
}

function endpoint(sessionId: string, side: PairSide, createdAt: number, agent?: string, model?: ModelRef): PairEndpoint {
  return {
    sessionId,
    side,
    ownerPid: process.pid,
    status: 'idle',
    createdAt,
    updatedAt: createdAt,
    heartbeatAt: createdAt,
    agent,
    model,
  };
}

function sideFor(pair: CrosstalkPair, sessionId: string): PairSide | undefined {
  if (pair.source.sessionId === sessionId) {
    return 'source';
  }
  if (pair.buddy.sessionId === sessionId) {
    return 'buddy';
  }
  return undefined;
}

function pairFor(state: CrosstalkState, sessionId: string): CrosstalkPair | undefined {
  return Object.values(state.pairs).find((pair) => sideFor(pair, sessionId));
}

function otherSide(side: PairSide): PairSide {
  return side === 'source' ? 'buddy' : 'source';
}

function messagesFor(state: CrosstalkState, pairId: string): CrosstalkMessage[] {
  return state.messages
    .filter((message) => message.pairId === pairId)
    .sort((left, right) => left.createdAt - right.createdAt || left.sequence - right.sequence);
}

function viewFor(state: CrosstalkState, sessionId: string): PairView {
  const pair = pairFor(state, sessionId);
  const selfSide = pair ? sideFor(pair, sessionId) : undefined;
  const self = pair && selfSide ? pair[selfSide] : undefined;
  const buddy = pair && selfSide ? pair[otherSide(selfSide)] : undefined;
  const messages = pair ? messagesFor(state, pair.id) : [];
  return {
    pair,
    selfSide,
    self,
    buddy,
    messages,
    unread: messages.filter((message) => message.toSessionId === sessionId && !message.readAt),
  };
}

function cleanupState(state: CrosstalkState): void {
  const cutoff = now() - MESSAGE_TTL_MS;
  const pairIds = new Set(Object.keys(state.pairs));
  state.messages = state.messages.filter((message) => pairIds.has(message.pairId) && message.createdAt >= cutoff);
  for (const message of state.messages) {
    message.label ||= crosstalkMessageLabel(message.fromSide, message.toSide, message.replyTo);
  }
}

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });
}

async function readStateFile(): Promise<CrosstalkState> {
  await ensureStateDir();

  try {
    const text = await fs.readFile(stateFile(), 'utf8');
    const parsed = JSON.parse(text) as CrosstalkState;
    if (parsed.version !== 2 || typeof parsed.pairs !== 'object' || !Array.isArray(parsed.messages)) {
      await quarantineStateFile();
      return emptyState();
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return emptyState();
    }
    await quarantineStateFile();
    return emptyState();
  }
}

async function writeStateFile(state: CrosstalkState): Promise<void> {
  await ensureStateDir();
  const temp = path.join(stateDir(), `state.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(state, null, 2));
  await fs.rename(temp, stateFile());
}

async function acquireLock(): Promise<() => Promise<void>> {
  await ensureStateDir();

  for (;;) {
    try {
      await fs.mkdir(lockDir());
      return async () => {
        await fs.rm(lockDir(), { recursive: true, force: true });
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }

      const stat = await fs.stat(lockDir()).catch(() => undefined);
      if (stat && now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lockDir(), { recursive: true, force: true });
        continue;
      }

      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function mutateState<T>(apply: (state: CrosstalkState) => Promise<T> | T): Promise<T> {
  const release = await acquireLock();

  try {
    const state = await readStateFile();
    cleanupState(state);
    const result = await apply(state);
    cleanupState(state);
    await writeStateFile(state);
    return result;
  } finally {
    await release();
  }
}

export function statePath(): string {
  return stateFile();
}

export async function getPairView(sessionId: string): Promise<PairView> {
  const state = await readStateFile();
  cleanupState(state);
  return viewFor(state, sessionId);
}

export async function createPair(input: {
  sourceSessionId: string;
  buddySessionId: string;
  agent?: string;
  model?: ModelRef;
}): Promise<PairView> {
  return mutateState((state) => {
    const existing = pairFor(state, input.sourceSessionId) || pairFor(state, input.buddySessionId);
    if (existing) {
      return viewFor(state, input.sourceSessionId);
    }

    const createdAt = now();
    const pair: CrosstalkPair = {
      id: input.sourceSessionId,
      source: endpoint(input.sourceSessionId, 'source', createdAt, input.agent, input.model),
      buddy: endpoint(input.buddySessionId, 'buddy', createdAt, input.agent, input.model),
      createdAt,
      updatedAt: createdAt,
      nextMessage: 1,
    };
    state.pairs[pair.id] = pair;
    return viewFor(state, input.sourceSessionId);
  });
}

export async function removeSession(sessionId: string): Promise<void> {
  await mutateState((state) => {
    const pair = pairFor(state, sessionId);
    const side = pair ? sideFor(pair, sessionId) : undefined;
    if (!pair || !side) {
      return;
    }
    const deletedAt = now();
    pair[side].deletedAt = deletedAt;
    pair[side].status = 'idle';
    pair[side].ownerPid = undefined;
    pair[side].updatedAt = deletedAt;
    pair.updatedAt = deletedAt;
  });
}

export async function addMessage(
  sessionId: string,
  body: string,
  replyTo?: string,
): Promise<{ view: PairView; message?: CrosstalkMessage; error?: 'not-paired' | 'empty' | 'unknown-reply' | 'target-deleted' }> {
  return mutateState((state) => {
    const pair = pairFor(state, sessionId);
    const selfSide = pair ? sideFor(pair, sessionId) : undefined;
    if (!pair || !selfSide) {
      return { view: viewFor(state, sessionId), error: 'not-paired' };
    }

    const text = normalizeMessage(body, MAX_MESSAGE_LENGTH);
    if (!text) {
      return { view: viewFor(state, sessionId), error: 'empty' };
    }

    if (replyTo) {
      const target = state.messages.find(
        (message) => message.pairId === pair.id && message.id === replyTo && message.toSessionId === sessionId,
      );
      if (!target) {
        return { view: viewFor(state, sessionId), error: 'unknown-reply' };
      }
    }

    const createdAt = now();
    const targetSide = otherSide(selfSide);
    const self = pair[selfSide];
    const target = pair[targetSide];
    if (target.deletedAt) {
      return { view: viewFor(state, sessionId), error: 'target-deleted' };
    }
    const sequence = pair.nextMessage;
    const message: CrosstalkMessage = {
      id: `m${sequence}`,
      sequence,
      pairId: pair.id,
      label: crosstalkMessageLabel(selfSide, targetSide, replyTo),
      fromSide: selfSide,
      toSide: targetSide,
      fromSessionId: self.sessionId,
      toSessionId: target.sessionId,
      body: text,
      createdAt,
      replyTo,
    };

    state.messages.push(message);
    pair.nextMessage += 1;
    pair.updatedAt = createdAt;
    self.updatedAt = createdAt;
    self.heartbeatAt = createdAt;
    return { view: viewFor(state, sessionId), message };
  });
}

export async function readMessages(sessionId: string, limit = 20): Promise<PairView> {
  return mutateState((state) => {
    const view = viewFor(state, sessionId);
    if (!view.pair) {
      return view;
    }

    const visible = view.messages
      .filter((message) => message.toSessionId === sessionId)
      .slice(-Math.max(1, Math.min(limit, 100)));
    const readAt = now();
    for (const message of visible) {
      if (!message.readAt) {
        message.readAt = readAt;
      }
    }

    return viewFor(state, sessionId);
  });
}

export async function syncLocalSessions(local: Map<string, LocalSession>): Promise<WakeCandidate[]> {
  return mutateState((state) => {
    const updatedAt = now();
    for (const [sessionId, localState] of local) {
      const pair = pairFor(state, sessionId);
      const side = pair ? sideFor(pair, sessionId) : undefined;
      if (!pair || !side || pair[side].deletedAt) {
        continue;
      }
      pair[side].ownerPid = process.pid;
      pair[side].status = localState.status;
      pair[side].updatedAt = updatedAt;
      pair[side].heartbeatAt = updatedAt;
    }

    const wake: WakeCandidate[] = [];
    for (const [sessionId, localState] of local) {
      if (localState.status !== 'idle') {
        continue;
      }

      const pair = pairFor(state, sessionId);
      const side = pair ? sideFor(pair, sessionId) : undefined;
      if (!pair || !side || pair[side].deletedAt) {
        continue;
      }

      const unseen = state.messages.filter(
        (message) =>
          message.pairId === pair.id &&
          message.toSessionId === sessionId &&
          !message.readAt &&
          (!message.wakeAt || updatedAt - message.wakeAt >= WAKE_RETRY_MS),
      );
      if (unseen.length === 0) {
        continue;
      }

      wake.push({
        sessionId,
        pairId: pair.id,
        fromSide: unseen[0].fromSide,
        messageIds: unseen.map((message) => message.id),
      });
    }

    return wake;
  });
}

export async function markWake(sessionId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }

  await mutateState((state) => {
    const wakeAt = now();
    for (const message of state.messages) {
      if (message.toSessionId === sessionId && messageIds.includes(message.id) && !message.readAt) {
        message.wakeAt = wakeAt;
      }
    }
  });
}
