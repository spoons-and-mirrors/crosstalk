// This file tests the real crosstalk plugin hooks and paired buddy behavior end to end.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import plugin from '../src/index';
import { statePath } from '../src/room';
import { __resetForTests } from '../src/test-support';
import type { ConfigTransformOutput, MessagesTransformOutput, OpenCodeSessionClient } from '../src/types';

type CrosstalkArgs = { action: string; message?: string; label?: string; reply_to?: string; limit?: number };
type HookMap = Record<string, ((input: unknown, output?: unknown) => Promise<unknown>) | undefined> & {
  tool?: {
    crosstalk: {
      execute: (args: CrosstalkArgs, context: unknown) => Promise<string>;
    };
  };
  config?: (output: ConfigTransformOutput) => Promise<void>;
};

type PluginEvent = {
  type: string;
  properties: Record<string, unknown>;
};
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
  const created: Array<{ body?: { title?: string; agent?: string; model?: unknown }; title?: string; agent?: string; model?: unknown }> = [];
  const history = new Map<string, ReturnType<typeof message>[]>();
  let nextSession = 1;

  const session = {
    calls: prompts,
    created,
    history,
    async create(this: { created: typeof created }, input: { body?: { title?: string; agent?: string; model?: unknown }; title?: string }) {
      this.created.push(input);
      return { data: { id: `buddy_${nextSession++}`, title: input.body?.title || input.title } };
    },
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
    created,
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

async function runCommand(hooks: HookMap, input: { command: string; sessionID: string; arguments: string }) {
  try {
    await hooks['command.execute.before']?.(input, { parts: [] });
  } catch {}
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

  test('registers command metadata and crosstalk for subagents', async () => {
    const { hooks } = await init();
    const config: ConfigTransformOutput = {};

    await hooks.config?.(config as never);

    expect(config.command?.crosstalk?.description).toBe('Show crosstalk buddy status');
    expect(config.command?.crosstalk?.template).toBe('$ARGUMENTS');
    expect(config.experimental?.subagent_tools).toContain('crosstalk');
  });

  test('status command is informational and does not create a buddy', async () => {
    const { hooks, created, prompts } = await init();

    await runCommand(hooks, { command: 'crosstalk', sessionID: 's1', arguments: '' });

    expect(created).toHaveLength(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].body.noReply).toBe(true);
    expect(prompts[0].body.parts[0].ignored).toBe(true);
    expect(prompts[0].body.parts[0].text).toContain('No crosstalk buddy exists yet');
  });

  test('send lazily creates a buddy with the source agent and model', async () => {
    const { hooks, created, history, prompts } = await init();
    history.set('s1', [message('s1', 'start', { agent: 'build', model: { providerID: 'anthropic', modelID: 'claude-sonnet' } })]);

    const result = await hooks.tool!.crosstalk.execute(
      { action: 'send', label: 'parser edge cases', message: 'please inspect parser edge cases' },
      toolContext('s1'),
    );

    expect(result).toContain('Sent crosstalk message m1');
    expect(result).toContain('buddy_1');
    expect(created).toEqual([
      {
        body: {
          title: 'crosstalk buddy for s1',
          agent: 'build',
          model: { providerID: 'anthropic', id: 'claude-sonnet', variant: undefined },
        },
      },
    ]);
    expect(prompts.some((prompt) => prompt.id === 'buddy_1' && prompt.body.parts[0].text?.includes('buddy session'))).toBe(true);

    const state = JSON.parse(await Bun.file(statePath()).text()) as {
      version: number;
      messages: Array<{ body: string; label: string }>;
    };
    expect(state.version).toBe(2);
    expect(state.messages[0].body).toBe('please inspect parser edge cases');
    expect(state.messages[0].label).toBe('parser edge cases');
  });

  test('read returns full message bodies and reply targets the original sender', async () => {
    const { hooks, history } = await init();
    history.set('s1', [message('s1', 'start')]);
    history.set('buddy_1', [message('buddy_1', 'buddy start')]);

    await hooks.tool!.crosstalk.execute(
      { action: 'send', label: 'patch review', message: 'can you review this patch?' },
      toolContext('s1'),
    );

    const read = await hooks.tool!.crosstalk.execute({ action: 'read' }, toolContext('buddy_1'));
    expect(read).toContain('m1 patch review');
    expect(read).toContain('can you review this patch?');

    const reply = await hooks.tool!.crosstalk.execute(
      { action: 'reply', reply_to: 'm1', label: 'review result', message: 'reviewed it, focus on error handling' },
      toolContext('buddy_1'),
    );
    expect(reply).toContain('Sent crosstalk message m2');

    const sourceRead = await hooks.tool!.crosstalk.execute({ action: 'read' }, toolContext('s1'));
    expect(sourceRead).toContain('m2 review result');
    expect(sourceRead).toContain('reviewed it, focus on error handling');
  });

  test('message transform projects crosstalk timeline without full inbound body', async () => {
    const { hooks, history } = await init();
    history.set('s1', [message('s1', 'start')]);

    await hooks.tool!.crosstalk.execute(
      { action: 'send', label: 'secret investigation', message: 'secret body should stay in read output' },
      toolContext('s1'),
    );
    await hooks.tool!.crosstalk.execute({ action: 'read' }, toolContext('buddy_1'));
    await hooks.tool!.crosstalk.execute({ action: 'reply', reply_to: 'm1', message: 'got it' }, toolContext('buddy_1'));
    const last = message('buddy_1', 'continue work');
    const output: MessagesTransformOutput = { messages: [last] };

    await runMessages(hooks, output);

    expect(output.messages).toHaveLength(3);
    expect(output.messages[0].parts[0].synthetic).toBe(true);
    expect(output.messages[0].parts[0].text).toContain('Buddy sent a crosstalk message');
    expect(output.messages[0].parts[0].text).toContain('secret investigation');
    expect(output.messages[0].parts[0].text).toContain('crosstalk({"action":"read"})');
    expect(output.messages[0].parts[0].text).not.toContain('secret body');
    expect(output.messages[1].parts[0].text).toContain('You sent a crosstalk message to your buddy');
  });

  test('adds crosstalk system prompt to normal session requests', async () => {
    const { hooks } = await init();
    const system: string[] = [];

    await runSystem(hooks, 'new-session', system);

    expect(system[0]).toContain('parallel coworker session');
    expect(system[0]).toContain('second working thread');
    expect(system[0]).toContain('What can I do while the buddy does something else useful?');
    expect(system[0]).toContain('two-person team');
    expect(system[0]).toContain('real parallel capacity');
    expect(system[0]).toContain('main track and a buddy track');
    expect(system[0]).toContain('non-conflicting sub-tasks');
    expect(system[0]).toContain('main session remains responsible for final task completion');
    expect(system[0]).toContain('Do not assume the buddy has your full conversation context');
    expect(system[0]).toContain('self-contained handoff');
    expect(system[0]).toContain('include enough context');
    expect(system[0]).toContain('what you are doing in the main session');
    expect(system[0]).toContain('what not to touch');
    expect(system[0]).toContain('priority order of the information you need');
    expect(system[0]).toContain('Avoid vague messages');
    expect(system[0]).toContain('should not work for a long time without updating the main session');
    expect(system[0]).toContain('early useful partial result');
    expect(system[0]).toContain('Do not poll the buddy');
    expect(system[0]).toContain('sleep/wait commands');
    expect(system[0]).toContain('nothing else useful to do');
    expect(system[0]).toContain('crosstalk({"action":"read"})');
  });

  test('wakes idle buddy sessions by asking them to read crosstalk', async () => {
    const { hooks, history, prompts } = await init();
    history.set('s1', [message('s1', 'start')]);
    history.set('buddy_1', [message('buddy_1', 'buddy start')]);

    await runStatus(hooks, 'buddy_1', 'idle');
    await hooks.tool!.crosstalk.execute({ action: 'send', message: 'wake and help please' }, toolContext('s1'));

    expect(prompts.some((prompt) => prompt.id === 'buddy_1' && prompt.body.parts[0].text?.includes('action":"read'))).toBe(true);
    expect(prompts.some((prompt) => prompt.body.parts[0].text?.includes('wake and help please'))).toBe(false);
  });

  test('session deletion preserves history and blocks delivery to the deleted endpoint', async () => {
    const { hooks, history } = await init();
    history.set('s1', [message('s1', 'start')]);

    await hooks.tool!.crosstalk.execute({ action: 'send', message: 'temporary work' }, toolContext('s1'));
    await runDeleted(hooks, 'buddy_1');

    const state = JSON.parse(await Bun.file(statePath()).text()) as {
      pairs: Record<string, { buddy: { deletedAt?: number } }>;
      messages: Array<{ body: string }>;
    };
    expect(Object.keys(state.pairs)).toHaveLength(1);
    expect(state.pairs.s1.buddy.deletedAt).toBeNumber();
    expect(state.messages[0].body).toBe('temporary work');

    const status = await hooks.tool!.crosstalk.execute({ action: 'status' }, toolContext('s1'));
    expect(status).toContain('deleted at');

    const send = await hooks.tool!.crosstalk.execute({ action: 'send', message: 'are you still there?' }, toolContext('s1'));
    expect(send).toContain('buddy session was deleted');
  });

  test('corrupt persisted state is quarantined before creating fresh state', async () => {
    const { hooks, history, dir } = await init();
    history.set('s1', [message('s1', 'start')]);
    await fs.writeFile(statePath(), '{not json');

    await hooks.tool!.crosstalk.execute({ action: 'send', message: 'recover from bad state' }, toolContext('s1'));

    const files = await fs.readdir(dir);
    expect(files.some((file) => file.startsWith('state.corrupt.') && file.endsWith('.json'))).toBe(true);
    const state = JSON.parse(await Bun.file(statePath()).text()) as { version: number; messages: Array<{ body: string }> };
    expect(state.version).toBe(2);
    expect(state.messages[0].body).toBe('recover from bad state');
  });
});
