// This file runs a live OpenCode server with Crosstalk loaded and checks real join and wake behavior.

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createOpencodeClient } from '../tmp/opencode/packages/sdk/js/src/client';

type LiveServer = {
  dir: string;
  proc: Bun.Subprocess;
  url: string;
};

type SessionInfo = {
  id: string;
};

type SessionMessage = {
  info: {
    role: string;
    sessionID: string;
  };
  parts: Array<{
    type: string;
    text?: string;
    tool?: string;
    state?: {
      output?: string;
    };
  }>;
};

type QueueItem =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> };

const CROSSTALK = '/home/spoon/code/ocplugins/crosstalk';

function sseLine(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function roleChunk() {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{ delta: { role: 'assistant' } }],
  };
}

function textChunk(text: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{ delta: { content: text } }],
  };
}

function toolStartChunk(id: string, name: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: {
                name,
                arguments: '',
              },
            },
          ],
        },
      },
    ],
  };
}

function toolArgsChunk(text: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: text,
              },
            },
          ],
        },
      },
    ],
  };
}

function finishChunk(reason: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{ delta: {}, finish_reason: reason }],
  };
}

function streamLines(lines: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(enc.encode(line));
      }
      controller.close();
    },
  });
}

function createFakeLLM() {
  const queue: QueueItem[] = [];
  const hits: Array<Record<string, unknown>> = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      hits.push(body);

      if (JSON.stringify(body).includes('Generate a title for this conversation')) {
        return new Response(
          streamLines([
            sseLine(roleChunk()),
            sseLine(textChunk('E2E Title')),
            sseLine(finishChunk('stop')),
            'data: [DONE]\n\n',
          ]),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }

      const next = queue.shift() || { type: 'text', text: 'ok' };
      if (next.type === 'text') {
        return new Response(
          streamLines([
            sseLine(roleChunk()),
            sseLine(textChunk(next.text)),
            sseLine(finishChunk('stop')),
            'data: [DONE]\n\n',
          ]),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }

      const args = JSON.stringify(next.input);
      return new Response(
        streamLines([
          sseLine(roleChunk()),
          sseLine(toolStartChunk('call_1', next.name)),
          sseLine(toolArgsChunk(args)),
          sseLine(finishChunk('tool_calls')),
          'data: [DONE]\n\n',
        ]),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });

  return {
    port: server.port,
    stop() {
      server.stop(true);
    },
    queue,
    hits,
  };
}

async function startServer(baseURL: string): Promise<LiveServer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crosstalk-live-'));
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  const config = {
    plugin: [CROSSTALK],
    provider: {
      test: {
        name: 'Test',
        id: 'test',
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          'test-model': {
            id: 'test-model',
            name: 'Test Model',
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: '2025-01-01',
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {
          apiKey: 'test-key',
          baseURL,
        },
      },
    },
  };

  const proc = Bun.spawn(['opencode', 'serve', '--hostname=127.0.0.1', `--port=${port}`], {
    cwd: dir,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_CROSSTALK_DIR: path.join(dir, 'crosstalk'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let output = '';
  const started = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(async () => {
      const err = await new Response(proc.stderr).text();
      reject(new Error(`Timed out waiting for server start.\nstdout:\n${output}\nstderr:\n${err}`));
    }, 15000);

    const read = async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          clearTimeout(timer);
          const err = await new Response(proc.stderr).text();
          reject(new Error(`Server exited before startup.\nstdout:\n${output}\nstderr:\n${err}`));
          return;
        }
        output += dec.decode(chunk.value, { stream: true });
        const match = output.match(/opencode server listening on\s+(https?:\/\/\S+)/);
        if (!match) {
          continue;
        }
        clearTimeout(timer);
        resolve(match[1]);
        return;
      }
    };

    void read();
  });

  reader.releaseLock();
  return { dir, proc, url: started };
}

async function stopServer(server: LiveServer) {
  server.proc.kill();
  await server.proc.exited.catch(() => undefined);
  await fs.rm(server.dir, { recursive: true, force: true });
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeout = 15000) {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value !== undefined) {
      return value;
    }
    last = value;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}. last=${JSON.stringify(last)}`);
}

async function listMessages(client: ReturnType<typeof createOpencodeClient>, sessionID: string) {
  const res = await client.session.messages({ path: { id: sessionID } });
  return res.data as SessionMessage[];
}

async function join(client: ReturnType<typeof createOpencodeClient>, sessionID: string, name: string) {
  try {
    await client.session.command({
      path: { id: sessionID },
      body: { command: 'crosstalk', arguments: `join ${name}` },
    });
  } catch {}
}

async function waitForText(client: ReturnType<typeof createOpencodeClient>, sessionID: string, text: string) {
  return waitFor(`text ${text}`, async () => {
    const list = await listMessages(client, sessionID);
    return list.find((msg) => msg.parts.some((part) => part.type === 'text' && part.text?.includes(text)));
  });
}

async function waitForInboxHit(hits: Array<Record<string, unknown>>, from: string, text: string) {
  return waitFor(`inbox hit ${from}:${text}`, async () => {
    for (const hit of hits) {
      const json = JSON.stringify(hit);
      if (!json.includes('broadcast')) {
        continue;
      }
      if (!json.includes(from) || !json.includes(text)) {
        continue;
      }
      return hit;
    }
  });
}

let live: LiveServer | undefined;

afterEach(async () => {
  if (!live) {
    return;
  }
  await stopServer(live);
  live = undefined;
});

describe('crosstalk live smoke', () => {
  test(
    'real server joins two sessions and wakes the recipient on broadcast',
    async () => {
      const llm = createFakeLLM();
      live = await startServer(`http://127.0.0.1:${llm.port}/v1`);
      const client = createOpencodeClient({ baseUrl: live.url, directory: live.dir });

      const sender = (await client.session.create({ body: { title: 'sender' } })).data as SessionInfo;
      const receiver = (await client.session.create({ body: { title: 'receiver' } })).data as SessionInfo;

      await client.session.prompt({
        path: { id: receiver.id },
        body: {
          noReply: true,
          agent: 'build',
          model: { providerID: 'test', modelID: 'test-model' },
          parts: [{ type: 'text', text: 'seed receiver model' }],
        },
      });

      await join(client, sender.id, 'sender');
      await join(client, receiver.id, 'receiver');

      await waitForText(client, sender.id, 'Joined crosstalk as sender');
      await waitForText(client, receiver.id, 'Joined crosstalk as receiver');

      llm.queue.push({
        type: 'tool',
        name: 'broadcast',
        input: { send_to: 'receiver', message: 'hello from sender' },
      });
      llm.queue.push({ type: 'text', text: 'sent' });

      await client.session.prompt({
        path: { id: sender.id },
        body: {
          agent: 'build',
          model: { providerID: 'test', modelID: 'test-model' },
          parts: [{ type: 'text', text: 'Use broadcast to send hello from sender to receiver.' }],
        },
      });

      const wake = await waitForText(client, receiver.id, 'New message from sender');
      expect(wake.info.sessionID).toBe(receiver.id);

      const inbox = await waitForInboxHit(llm.hits, 'sender', 'hello from sender');
      expect(JSON.stringify(inbox)).toContain('receiver');
      expect(JSON.stringify(inbox)).toContain('hello from sender');

      llm.stop();
    },
    30000,
  );
});
