// This file owns the in-memory process state for local paired sessions and wake polling.

import type { LocalSession, OpenCodeSessionClient } from './types';

export const localSessions = new Map<string, LocalSession>();
export const waking = new Set<string>();

let poller: ReturnType<typeof setInterval> | undefined;
let client: OpenCodeSessionClient | undefined;

export function getPoller() {
  return poller;
}

export function setPoller(value: ReturnType<typeof setInterval> | undefined): void {
  poller = value;
}

export function getClient() {
  return client;
}

export function setClient(value: OpenCodeSessionClient | undefined): void {
  client = value;
}

export function resetForTests(): void {
  localSessions.clear();
  waking.clear();
  client = undefined;

  if (!poller) {
    return;
  }

  clearInterval(poller);
  poller = undefined;
}
