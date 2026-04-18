// This file is the single source of truth for the shared crosstalk room stored on disk.

import * as fs from 'fs/promises';
import * as path from 'path';
import type { HandledMessage, LocalSession, RoomView, SharedMessage, SharedRoom, SharedSession, WakeCandidate } from './types';
import { DEFAULT_ROOM, MAX_MESSAGE_LENGTH, MAX_STATUS_LENGTH, normalizeMessage } from './prompts';

const LOCK_STALE_MS = 10000;
const LOCK_RETRY_MS = 50;
const SESSION_TTL_MS = 30000;
const MESSAGE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_STATUS_HISTORY = 50;
const WAKE_RETRY_MS = 5000;

function roomDir(): string {
  return process.env.OPENCODE_CROSSTALK_DIR || path.join(process.env.HOME || '', '.local', 'state', 'opencode-crosstalk');
}

function roomFile(): string {
  return path.join(roomDir(), 'room.json');
}

function lockDir(): string {
  return path.join(roomDir(), 'room.lock');
}

function emptyRoom(): SharedRoom {
  return {
    version: 1,
    sessions: {},
    messages: [],
  };
}

function roomNow(): number {
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function cleanName(name?: string): string {
  const value = name?.replace(/\s+/g, ' ').trim() || 'session';
  if (value.length <= 80) {
    return value;
  }
  return value.slice(0, 80).trim() || 'session';
}

function cleanRoom(name?: string): string {
  const value = name?.replace(/\s+/g, ' ').trim() || DEFAULT_ROOM;
  if (value.length <= 80) {
    return value;
  }
  return value.slice(0, 80).trim() || DEFAULT_ROOM;
}

function roomActive(session: SharedSession, now: number): boolean {
  if (session.ownerPid && !processAlive(session.ownerPid)) {
    return false;
  }

  return now - session.heartbeatAt <= SESSION_TTL_MS;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'EPERM') {
      return true;
    }

    return false;
  }
}

function cleanupRoom(room: SharedRoom): void {
  const now = roomNow();
  const active = new Set<string>();

  for (const sessionId of Object.keys(room.sessions)) {
    const session = room.sessions[sessionId];
    if (!roomActive(session, now)) {
      delete room.sessions[sessionId];
      continue;
    }
    active.add(sessionId);
  }

  room.messages = room.messages.filter((message) => {
    if (!active.has(message.toSessionId)) {
      return false;
    }

    if (now - message.createdAt > MESSAGE_TTL_MS) {
      return false;
    }

    if (!message.handledAt) {
      return true;
    }

    return now - message.handledAt <= MESSAGE_TTL_MS;
  });
}

async function ensureRoomDir(): Promise<void> {
  await fs.mkdir(roomDir(), { recursive: true });
}

async function readRoomFile(): Promise<SharedRoom> {
  await ensureRoomDir();

  try {
    const text = await fs.readFile(roomFile(), 'utf8');
    const parsed = JSON.parse(text) as SharedRoom;
    if (parsed.version !== 1 || typeof parsed.sessions !== 'object' || !Array.isArray(parsed.messages)) {
      return emptyRoom();
    }
    for (const session of Object.values(parsed.sessions)) {
      session.room = cleanRoom(session.room);
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return emptyRoom();
    }
    return emptyRoom();
  }
}

async function writeRoomFile(room: SharedRoom): Promise<void> {
  await ensureRoomDir();
  const temp = path.join(roomDir(), `room.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(room, null, 2));
  await fs.rename(temp, roomFile());
}

async function acquireLock(): Promise<() => Promise<void>> {
  await ensureRoomDir();

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
      if (stat && roomNow() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lockDir(), { recursive: true, force: true });
        continue;
      }

      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function mutateRoom<T>(apply: (room: SharedRoom) => Promise<T> | T): Promise<T> {
  const release = await acquireLock();

  try {
    const room = await readRoomFile();
    cleanupRoom(room);
    const result = await apply(room);
    cleanupRoom(room);
    await writeRoomFile(room);
    return result;
  } finally {
    await release();
  }
}

function uniqueAlias(room: SharedRoom, base: string, sessionId: string, roomName: string): string {
  const name = cleanName(base);
  const taken = new Set(
    Object.values(room.sessions)
      .filter((session) => session.sessionId !== sessionId && session.room === roomName)
      .map((session) => session.alias.toLowerCase()),
  );

  if (!taken.has(name.toLowerCase())) {
    return name;
  }

  for (const index of Array.from({ length: 9999 }, (_, value) => value + 2)) {
    const alias = `${name}-${index}`;
    if (!taken.has(alias.toLowerCase())) {
      return alias;
    }
  }

  return `${name}-${Date.now()}`;
}

function peerList(room: SharedRoom, sessionId: string, roomName?: string): SharedSession[] {
  const ownRoom = roomName || room.sessions[sessionId]?.room || DEFAULT_ROOM;
  return Object.values(room.sessions)
    .filter((session) => session.sessionId !== sessionId && session.room === ownRoom)
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

function roomView(room: SharedRoom, sessionId: string): RoomView {
  const self = room.sessions[sessionId];
  return {
    self,
    room: self?.room,
    peers: peerList(room, sessionId, self?.room),
    messages: room.messages
      .filter((message) => message.toSessionId === sessionId && !message.handledAt)
      .sort((left, right) => left.msgIndex - right.msgIndex),
  };
}

function nextInternalId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function findByAlias(room: SharedRoom, alias: string, roomName: string): SharedSession | undefined {
  const wanted = alias.trim().toLowerCase();
  return Object.values(room.sessions).find((session) => session.room === roomName && session.alias.toLowerCase() === wanted);
}

export async function getRoomView(sessionId: string): Promise<RoomView> {
  const room = await readRoomFile();
  cleanupRoom(room);
  return roomView(room, sessionId);
}

export async function joinRoom(sessionId: string, wanted?: string, roomName?: string): Promise<{ alias: string; room: string }> {
  return mutateRoom((room) => {
    const now = roomNow();
    const current = room.sessions[sessionId];
    const nextRoom = cleanRoom(roomName || current?.room || DEFAULT_ROOM);
    const previousRoom = current?.room || DEFAULT_ROOM;
    const moved = previousRoom !== nextRoom;
    const alias = uniqueAlias(room, wanted || current?.alias || 'session', sessionId, nextRoom);

    if (moved) {
      room.messages = room.messages.filter(
        (message) => message.toSessionId !== sessionId && message.fromSessionId !== sessionId,
      );
    }

    room.sessions[sessionId] = {
      sessionId,
      alias,
      room: nextRoom,
      ownerPid: process.pid,
      joinedAt: current?.joinedAt || now,
      updatedAt: now,
      heartbeatAt: now,
      status: current?.status || 'idle',
      history: moved ? [] : current?.history || [],
      nextMessage: moved ? 1 : current?.nextMessage || 1,
    };
    return { alias, room: nextRoom };
  });
}

export async function dropRoom(sessionId: string): Promise<void> {
  await mutateRoom((room) => {
    delete room.sessions[sessionId];
    room.messages = room.messages.filter(
      (message) => message.toSessionId !== sessionId && message.fromSessionId !== sessionId,
    );
  });
}

export async function updateStatus(sessionId: string, status: string): Promise<RoomView> {
  return mutateRoom((room) => {
    const self = room.sessions[sessionId];
    if (!self) {
      return roomView(room, sessionId);
    }

    const now = roomNow();
    self.updatedAt = now;
    self.heartbeatAt = now;
    self.history.push(normalizeMessage(status, MAX_STATUS_LENGTH));
    if (self.history.length > MAX_STATUS_HISTORY) {
      self.history = self.history.slice(self.history.length - MAX_STATUS_HISTORY);
    }
    return roomView(room, sessionId);
  });
}

export async function sendMessage(
  sessionId: string,
  targetAlias: string,
  message: string,
): Promise<{
  self?: SharedSession;
  peers: SharedSession[];
  sentTo?: string;
  targetSessionId?: string;
  msgIndex?: number;
  error?: string;
}> {
  return mutateRoom((room) => {
    const self = room.sessions[sessionId];
    if (!self) {
      return { self: undefined, peers: [], error: 'not-joined' };
    }

    const target = findByAlias(room, targetAlias, self.room);
    const peers = peerList(room, sessionId, self.room);
    if (!target) {
      return { self, peers, error: 'unknown-recipient' };
    }

    if (target.sessionId === sessionId) {
      return { self, peers, error: 'self' };
    }

    const now = roomNow();
    const msgIndex = target.nextMessage;
    self.updatedAt = now;
    self.heartbeatAt = now;
    room.messages.push({
      id: nextInternalId(),
      msgIndex,
      fromSessionId: sessionId,
      from: self.alias,
      toSessionId: target.sessionId,
      body: normalizeMessage(message, MAX_MESSAGE_LENGTH),
      createdAt: now,
    });
    target.nextMessage += 1;
    target.updatedAt = now;
    return {
      self,
      peers: peerList(room, sessionId, self.room),
      sentTo: target.alias,
      targetSessionId: target.sessionId,
      msgIndex,
    };
  });
}

export async function handleReply(sessionId: string, msgIndex: number): Promise<HandledMessage | undefined> {
  return mutateRoom((room) => {
    const message = room.messages.find(
      (item) => item.toSessionId === sessionId && item.msgIndex === msgIndex && !item.handledAt,
    );
    if (!message) {
      return undefined;
    }

    message.handledAt = roomNow();
    return {
      id: message.msgIndex,
      from: message.from,
      body: message.body,
    };
  });
}

export function roomPath(): string {
  return roomFile();
}

export async function markPresented(sessionId: string, msgIndices: number[]): Promise<void> {
  if (msgIndices.length === 0) {
    return;
  }

  await mutateRoom((room) => {
    const now = roomNow();
    for (const message of room.messages) {
      if (message.toSessionId !== sessionId) {
        continue;
      }
      if (message.handledAt) {
        continue;
      }
      if (!msgIndices.includes(message.msgIndex)) {
        continue;
      }
      if (message.presentedAt) {
        continue;
      }
      message.wakeAt = now;
      message.presentedAt = now;
    }
  });
}

export async function markWake(sessionId: string, msgIndices: number[]): Promise<void> {
  if (msgIndices.length === 0) {
    return;
  }

  await mutateRoom((room) => {
    const now = roomNow();
    for (const message of room.messages) {
      if (message.toSessionId !== sessionId) {
        continue;
      }
      if (message.handledAt || message.presentedAt) {
        continue;
      }
      if (!msgIndices.includes(message.msgIndex)) {
        continue;
      }
      message.wakeAt = now;
    }
  });
}

export async function syncLocalSessions(local: Map<string, LocalSession>): Promise<WakeCandidate[]> {
  return mutateRoom((room) => {
    const now = roomNow();

    for (const [sessionId, state] of local) {
      const self = room.sessions[sessionId];
      if (!self) {
        continue;
      }
      self.alias = state.alias;
      self.ownerPid = process.pid;
      self.status = state.status;
      self.updatedAt = now;
      self.heartbeatAt = now;
    }

    const wake: WakeCandidate[] = [];
    for (const [sessionId, state] of local) {
      if (state.status !== 'idle') {
        continue;
      }

      const unseen = room.messages.filter(
        (message) =>
          message.toSessionId === sessionId &&
          !message.handledAt &&
          message.presentedAt === undefined &&
          (!message.wakeAt || now - message.wakeAt >= WAKE_RETRY_MS),
      );
      if (unseen.length === 0) {
        continue;
      }

      wake.push({
        sessionId,
        from: unseen[0].from,
        msgIndices: unseen.map((message) => message.msgIndex),
      });
    }

    return wake;
  });
}
