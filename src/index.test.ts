// This file tests the real crosstalk plugin hooks and shared room behavior end to end.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import plugin from './index';
import { roomPath } from './room';
import { __resetForTests } from './test-support';
import type { ConfigTransformOutput, MessagesTransformOutput, OpenCodeSessionClient } from './types';

type HookMap = Record<string, ((input: unknown, output?: unknown) => Promise<unknown>) | undefined> & {
  tool?: {
    broadcast: {
      execute: (args: { send_to?: string; message: string; reply_to?: number }, context: unknown) => Promise<string>;
    };
  };
  config?: (output: ConfigTransformOutput) => Promise<void>;
};

type PluginEvent = {
  type: string;
  properties: Record<string, unknown>;
};

type CommandOut = { parts: Array<{ type: string; text: string }> };
type PromptRecord = {
  id: string;
  body: { noReply?: boolean; parts: Array<{ type: string; text?: string; ignored?: boolean }>; agent?: string; model?: unknown };
};

function message(sessionID: string, text: string, extra?: { agent?: string; model?: { providerID?: string; modelID?: string } }) {
  return {
    info: {
      id: `msg_${sessionID}_${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      sessionID,
      agent: extra?.agent || 'build',
      model: extra?.model || { providerID: 'openai', modelID: 'gpt-5.4' },
      time: { created: Date.now() },
    },
    parts: [{ id: `part_${sessionID}`, sessionID, messageID: `msg_${sessionID}`, time: Date.now(), type: 'text', text }],
  };
}

function toolContext(sessionID: string) {
  return {
    sessionID,
    messageID: `tool_${sessionID}`,
    agent: 'build',
    directory: '/tmp',
    worktree: '/tmp',
    abort: new AbortController().signal,
    metadata() {},
    ask() {
      throw new Error('not implemented in test');
    },
  };
}

function createClient() {
  const prompts: PromptRecord[] = [];
  const history = new Map<string, ReturnType<typeof message>[]>();

  const session = {
    calls: prompts,
    history,
    async prompt(this: { calls: PromptRecord[] }, params: { path: { id: string }; body: PromptRecord['body'] }) {
      this.calls.push({ id: params.path.id, body: params.body });
      return { data: {} };
    },
    async promptAsync(this: { calls: PromptRecord[] }, params: { path: { id: string }; body: PromptRecord['body'] }) {
      this.calls.push({ id: params.path.id, body: params.body });
      return { data: {} };
    },
    async messages(this: { history: Map<string, ReturnType<typeof message>[]> }, params: { path: { id: string } }) {
      return { data: this.history.get(params.path.id) || [] };
    },
  };

  const client: OpenCodeSessionClient = { session };

  return {
    client,
    prompts,
    history,
  };
}

async function init() {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crosstalk-test-'));
  process.env.OPENCODE_CROSSTALK_DIR = testDir;
  const api = createClient();
  const hooks = (await plugin.server({
    client: api.client as never,
    directory: testDir,
    worktree: testDir,
    project: { id: 'proj', name: 'proj' } as never,
    experimental_workspace: { register() {} },
    serverUrl: new URL('http://localhost:4096'),
    $: Bun.$,
  })) as HookMap;

  return {
    ...api,
    hooks,
    dir: testDir,
  };
}

async function runCommand(hooks: HookMap, input: { command: string; sessionID: string; arguments: string }, output?: CommandOut) {
  const out = output || { parts: [] };
  let error: unknown;
  try {
    await hooks['command.execute.before']?.(input, out);
  } catch (cause) {
    error = cause;
  }
  return out;
}

async function runMessages(hooks: HookMap, output: MessagesTransformOutput) {
  await hooks['experimental.chat.messages.transform']?.({}, output as never);
}

async function runSystem(hooks: HookMap, sessionID: string, system: string[]) {
  await hooks['experimental.chat.system.transform']?.({ sessionID, model: {} }, { system });
}

async function runStatus(hooks: HookMap, sessionID: string, type: 'idle' | 'busy' | 'retry') {
  const event: PluginEvent = { type: 'session.status', properties: { sessionID, status: { type } } };
  await hooks.event?.({ event });
}

async function runIdle(hooks: HookMap, sessionID: string) {
  const event: PluginEvent = { type: 'session.idle', properties: { sessionID } };
  await hooks.event?.({ event });
}

async function runDeleted(hooks: HookMap, sessionID: string) {
  const event: PluginEvent = { type: 'session.deleted', properties: { info: { id: sessionID } } };
  await hooks.event?.({ event });
}

describe('crosstalk plugin', () => {
  beforeEach(() => {
    __resetForTests();
  });

  afterEach(async () => {
    const dir = process.env.OPENCODE_CROSSTALK_DIR;
    __resetForTests();
    delete process.env.OPENCODE_CROSSTALK_DIR;
    if (!dir) {
      return;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('registers command metadata and broadcast for subagents', async () => {
    const { hooks } = await init();
    const config: ConfigTransformOutput = {};

    await hooks.config?.(config as never);

    expect(config.command?.crosstalk?.description).toBe('Join or leave the crosstalk room');
    expect(config.command?.crosstalk?.template).toBe('$ARGUMENTS');
    expect(config.experimental?.subagent_tools).toContain('broadcast');
  });

  test('joins with requested alias and auto-suffixes duplicates', async () => {
    const { hooks, prompts } = await init();
    const outA = { parts: [{ type: 'text', text: 'seed' }] };
    const outB = { parts: [{ type: 'text', text: 'seed' }] };

    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join writer' }, outA);
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's2', arguments: 'join writer' }, outB);

    expect(outA.parts).toEqual([{ type: 'text', text: 'seed' }]);
    expect(outB.parts).toEqual([{ type: 'text', text: 'seed' }]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].body.noReply).toBe(true);
    expect(prompts[0].body.parts[0]).toEqual({ type: 'text', text: 'Joined crosstalk as writer.\n\nNo other joined sessions yet.', ignored: true });
    expect(prompts[1].body.parts[0]).toEqual({
      type: 'text',
      text: 'Joined crosstalk as writer-2.\n\nOther joined sessions:\n- writer',
      ignored: true,
    });

    const room = JSON.parse(await Bun.file(roomPath()).text()) as {
      sessions: Record<string, { alias: string }>;
    };
    expect(room.sessions.s1.alias).toBe('writer');
    expect(room.sessions.s2.alias).toBe('writer-2');
  });

  test('drops a joined session and removes its pending messages', async () => {
    const { hooks, prompts } = await init();
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join one' });
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's2', arguments: 'join two' });

    const sent = await hooks.tool!.broadcast.execute({ send_to: 'two', message: 'hello' }, toolContext('s1'));
    expect(typeof sent).toBe('string');
    const out = { parts: [] as Array<{ type: string; text: string }> };
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's2', arguments: 'drop' }, out);
    expect(out.parts).toEqual([]);
    expect(prompts.at(-1)?.body.parts[0]).toEqual({ type: 'text', text: 'Dropped from crosstalk.', ignored: true });

    const room = JSON.parse(await Bun.file(roomPath()).text()) as {
      sessions: Record<string, unknown>;
      messages: Array<{ toSessionId: string }>;
    };
    expect(room.sessions.s2).toBeUndefined();
    expect(room.messages.some((item) => item.toSessionId === 's2')).toBe(false);
  });

  test('drops joined local state on session.deleted events', async () => {
    const { hooks } = await init();
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join one' });
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's2', arguments: 'join two' });
    await hooks.tool!.broadcast.execute({ send_to: 'two', message: 'hello' }, toolContext('s1'));

    await runDeleted(hooks, 's2');

    const room = JSON.parse(await Bun.file(roomPath()).text()) as {
      sessions: Record<string, unknown>;
      messages: Array<{ toSessionId: string }>;
    };
    expect(room.sessions.s2).toBeUndefined();
    expect(room.messages.some((item) => item.toSessionId === 's2')).toBe(false);
  });

  test('broadcast status update stores visible history for peers', async () => {
    const { hooks } = await init();
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join alpha' });
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's2', arguments: 'join beta' });

    const result = await hooks.tool!.broadcast.execute({ message: 'thinking about parser edge cases' }, toolContext('s1'));
    expect(result).toContain('Status updated.');

    const output: MessagesTransformOutput = {
      messages: [message('s2', 'wake up')],
    };
    await runMessages(hooks, output);

    const injected = output.messages.at(-1) as { parts: Array<{ state?: { output?: string } }> };
    const payload = JSON.parse(injected.parts[0].state!.output!);
    expect(payload.sessions).toEqual([
      { name: 'alpha', status: ['thinking about parser edge cases'], idle: true },
    ]);
  });

  test('send_to uses the joined visible session name', async () => {
    const { hooks } = await init();
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join planner' });
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's2', arguments: 'join implementer' });

    const result = await hooks.tool!.broadcast.execute(
      { send_to: 'implementer', message: 'please take the migration' },
      toolContext('s1'),
    );

    expect(result).toContain('Message sent to: implementer');
  });

  test('rejects self-send and unknown recipients', async () => {
    const { hooks } = await init();
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join solo' });

    const self = await hooks.tool!.broadcast.execute({ send_to: 'solo', message: 'hi' }, toolContext('s1'));
    const missing = await hooks.tool!.broadcast.execute({ send_to: 'ghost', message: 'hi' }, toolContext('s1'));

    expect(self).toBe('Warning: You cannot send a message to yourself.');
    expect(missing).toBe('Error: Unknown recipient "ghost". No other joined sessions are available.');
  });

  test('injects synthetic inbox messages with peer list and unread message payload', async () => {
    const { hooks } = await init();
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join sender' });
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's2', arguments: 'join receiver' });
    await hooks.tool!.broadcast.execute({ send_to: 'receiver', message: 'check the failing snapshot' }, toolContext('s1'));

    const output: MessagesTransformOutput = {
      messages: [message('s2', 'current turn')],
    };
    await runMessages(hooks, output);

    expect(output.messages).toHaveLength(2);
    const injected = output.messages[1] as {
      info: { role: string; sessionID: string };
      parts: Array<{ type: string; tool: string; state: { status: string; output: string } }>;
    };
    expect(injected.info.role).toBe('assistant');
    expect(injected.parts[0].type).toBe('tool');
    expect(injected.parts[0].tool).toBe('broadcast');
    const payload = JSON.parse(injected.parts[0].state.output);
    expect(payload.you_are).toBe('receiver');
    expect(payload.messages).toEqual([{ id: 1, from: 'sender', content: 'check the failing snapshot' }]);
  });

  test('reply_to marks the inbox item handled and targets the original sender', async () => {
    const { hooks } = await init();
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join sender' });
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's2', arguments: 'join receiver' });
    await hooks.tool!.broadcast.execute({ send_to: 'receiver', message: 'need help on test flake' }, toolContext('s1'));

    const reply = await hooks.tool!.broadcast.execute(
      { reply_to: 1, message: 'looking now' },
      toolContext('s2'),
    );

    expect(reply).toContain('Replied to #1 from sender:');
    expect(reply).toContain('Message sent to: sender');

    const output: MessagesTransformOutput = {
      messages: [message('s2', 'next turn')],
    };
    await runMessages(hooks, output);
    const payload = JSON.parse((output.messages[1] as { parts: Array<{ state: { output: string } }> }).parts[0].state.output);
    expect(payload.messages).toEqual([]);
  });

  test('returns a clear error for invalid reply_to ids', async () => {
    const { hooks } = await init();
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join worker' });

    const result = await hooks.tool!.broadcast.execute({ reply_to: 99, message: 'nope' }, toolContext('s1'));

    expect(result).toBe('Error: Unknown reply target.');
  });

  test('adds crosstalk system prompt only for joined sessions', async () => {
    const { hooks } = await init();
    const before = { system: [] as string[] };
    await runSystem(hooks, 's1', before.system);
    expect(before.system).toEqual([]);

    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join agent one' });
    const after = { system: [] as string[] };
    await runSystem(hooks, 's1', after.system);
    expect(after.system).toHaveLength(1);
    expect(after.system[0]).toContain('Use `broadcast` to communicate with other joined sessions');
  });

  test('wakes idle joined sessions by injecting a real prompt', async () => {
    const { hooks, history, prompts } = await init();
    history.set('s2', [message('s2', 'prior user', { agent: 'build', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' } })]);

    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join sender' });
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's2', arguments: 'join sleeper' });
    await runStatus(hooks, 's2', 'idle');
    await hooks.tool!.broadcast.execute({ send_to: 'sleeper', message: 'wake up please' }, toolContext('s1'));
    await runIdle(hooks, 's2');

    const wake = prompts.find((item) => item.body.parts[0].text?.includes('New message from sender'));
    expect(wake).toBeDefined();
    expect(wake?.id).toBe('s2');
    expect(wake?.body.parts[0].text).toContain('New message from sender');
    expect(wake?.body.agent).toBe('build');
    expect(wake?.body.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4' });
  });

  test('wakes local joined recipients immediately on direct send', async () => {
    const { hooks, history, prompts } = await init();
    history.set('s2', [message('s2', 'prior user', { agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5.4' } })]);

    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join sender' });
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's2', arguments: 'join receiver' });
    prompts.length = 0;

    await hooks.tool!.broadcast.execute({ send_to: 'receiver', message: 'hello now' }, toolContext('s1'));

    expect(prompts).toHaveLength(1);
    expect(prompts[0].id).toBe('s2');
    expect(prompts[0].body.parts[0].text).toContain('New message from sender');
  });

  test('cleans dead process sessions on join so old peers do not linger after restart', async () => {
    const { hooks } = await init();
    await fs.writeFile(
      roomPath(),
      JSON.stringify({
        version: 1,
        sessions: {
          stale: {
            sessionId: 'stale',
            alias: 'ghost',
            ownerPid: 999999,
            joinedAt: Date.now(),
            updatedAt: Date.now(),
            heartbeatAt: Date.now(),
            status: 'idle',
            history: [],
            nextMessage: 1,
          },
        },
        messages: [],
      }),
    );

    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'join live' });

    const room = JSON.parse(await Bun.file(roomPath()).text()) as {
      sessions: Record<string, { alias: string }>;
    };
    expect(Object.keys(room.sessions)).toEqual(['s1']);
    expect(room.sessions.s1.alias).toBe('live');
  });

  test('command handler uses ignored noReply prompts instead of mutating command parts', async () => {
    const { hooks, prompts } = await init();
    const usage = { parts: [{ type: 'text', text: 'seed' }] };
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: 'wat' }, usage);
    expect(usage.parts).toEqual([{ type: 'text', text: 'seed' }]);
    expect(prompts[0].body).toEqual({
      noReply: true,
      parts: [{ type: 'text', text: 'Usage: /crosstalk join [name...] or /crosstalk drop', ignored: true }],
    });

    const join = { parts: [{ type: 'text', text: 'template text' }] };
    await runCommand(hooks, { command: 'crosstalk', sessionID: 's2', arguments: 'join local name' }, join);
    expect(join.parts).toEqual([{ type: 'text', text: 'template text' }]);
    expect(prompts[1].body).toEqual({
      noReply: true,
      parts: [{ type: 'text', text: 'Joined crosstalk as local name.\n\nNo other joined sessions yet.', ignored: true }],
    });
  });
});
