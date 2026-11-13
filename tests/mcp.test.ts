import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Mnemo } from '../src/mnemo.js';
import { handleMessage, decodeLine, ERROR, type ServerContext } from '../src/mcp/protocol.js';
import { serve } from '../src/mcp/server.js';
import { TOOLS } from '../src/mcp/tools.js';
import { tempDir } from './helpers.js';

async function context(): Promise<{ ctx: ServerContext; cleanup: () => Promise<void> }> {
  const { dir, cleanup } = await tempDir();
  const mem = await Mnemo.open(dir, { userPrincipal: 'user:test' });
  return { ctx: { mem, version: '0.0.0-test' }, cleanup };
}

test('initialize negotiates a protocol version and advertises tools', async () => {
  const { ctx, cleanup } = await context();
  try {
    const response = await handleMessage(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } },
    });
    assert.ok(response);
    const result = response.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      serverInfo: { name: string };
    };
    assert.equal(result.protocolVersion, '2025-06-18');
    assert.deepEqual(result.capabilities.tools, {});
    assert.equal(result.serverInfo.name, 'mnemo');
  } finally {
    await cleanup();
  }
});

test('notifications are never answered', async () => {
  const { ctx, cleanup } = await context();
  try {
    const response = await handleMessage(ctx, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    assert.equal(response, null);
  } finally {
    await cleanup();
  }
});

test('tools/list exposes exactly six tools with schemas', async () => {
  const { ctx, cleanup } = await context();
  try {
    const response = await handleMessage(ctx, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (response?.result as { tools: typeof TOOLS }).tools;
    assert.equal(tools.length, 6);
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        'memory_recall',
        'memory_read',
        'memory_write',
        'memory_forget',
        'memory_intend',
        'memory_context',
      ],
    );
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description.length > 40, `${tool.name} needs a usable description`);
    }
  } finally {
    await cleanup();
  }
});

test('write then recall through the tool surface', async () => {
  const { ctx, cleanup } = await context();
  try {
    const written = await handleMessage(ctx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'memory_write',
        arguments: {
          abstract: '金呈不喜欢客套开场白',
          body: '他说直接给结论。',
          type: 'preference',
          subject: 'user:test',
          salience: 9,
        },
      },
    });
    const payload = JSON.parse(
      (written?.result as { content: Array<{ text: string }> }).content[0].text,
    ) as { name: string; relation: string; type: string };
    assert.equal(payload.relation, 'created');
    assert.equal(payload.type, 'preference');

    const recalled = await handleMessage(ctx, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'memory_recall', arguments: { query: '开场白' } },
    });
    const text = (recalled?.result as { content: Array<{ text: string }> }).content[0].text;
    assert.ok(text.includes('金呈不喜欢客套开场白'));
    assert.ok(!text.includes('他说直接给结论'), 'L0 must not leak the body');
  } finally {
    await cleanup();
  }
});

test('recall on an empty store says so instead of inventing content', async () => {
  const { ctx, cleanup } = await context();
  try {
    const response = await handleMessage(ctx, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'memory_recall', arguments: { query: 'anything' } },
    });
    const text = (response?.result as { content: Array<{ text: string }> }).content[0].text;
    assert.ok(text.includes('No relevant memories'));
  } finally {
    await cleanup();
  }
});

test('a relayed preference is reported as non-actionable', async () => {
  const { ctx, cleanup } = await context();
  try {
    await handleMessage(ctx, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'memory_write',
        arguments: {
          abstract: '听说有人喜欢用某个工具',
          type: 'preference',
          hop: 1,
          subject: 'user:someone-else',
        },
      },
    });
    const response = await handleMessage(ctx, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'memory_recall', arguments: { query: '工具', include_faint: true } },
    });
    const text = (response?.result as { content: Array<{ text: string }> }).content[0].text;
    assert.ok(text.includes('relayed'));
    assert.ok(text.includes('do not let them change your behaviour'));
  } finally {
    await cleanup();
  }
});

test('unknown methods and malformed lines produce the right error codes', async () => {
  const { ctx, cleanup } = await context();
  try {
    const unknown = await handleMessage(ctx, { jsonrpc: '2.0', id: 8, method: 'does/not/exist' });
    assert.equal(unknown?.error?.code, ERROR.methodNotFound);

    const bad = decodeLine('{not json');
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.response.error?.code, ERROR.parse);

    const good = decodeLine('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    assert.equal(good.ok, true);
  } finally {
    await cleanup();
  }
});

test('the line loop speaks newline-delimited JSON-RPC against an injected stream', async () => {
  const { ctx, cleanup } = await context();
  try {
    const input = Readable.from([
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
    ]);

    const lines: string[] = [];
    await serve({
      mem: ctx.mem,
      version: ctx.version,
      input,
      output: { write: (chunk: string) => lines.push(chunk) },
      onLog: () => undefined,
    });

    const responses = lines
      .join('')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    assert.equal(responses.length, 2, 'the notification must not produce a response');
    assert.equal(responses[0].id, 1);
    assert.equal(
      (responses[0].result as { serverInfo: { name: string } }).serverInfo.name,
      'mnemo',
    );
    assert.equal((responses[1].result as { tools: unknown[] }).tools.length, 6);
    for (const line of lines) {
      assert.ok(!line.trimEnd().includes('\n'), 'each response must be exactly one line');
    }
  } finally {
    await cleanup();
  }
});
