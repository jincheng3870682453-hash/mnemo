#!/usr/bin/env node
/**
 * MCP server entry point.
 *
 * Configured entirely through environment variables so it can be launched by any
 * MCP host (ZCode, Claude Code, Cursor, …) without a config file:
 *
 *   MNEMO_DIR               store directory            (default ./.mnemo)
 *   MNEMO_AGENT_PRINCIPAL   identity of the assistant   (default agent:self)
 *   MNEMO_USER_PRINCIPAL    identity of the human       (default unset)
 *   MNEMO_VECTOR_MODE       off | auto | on             (default auto)
 *   MNEMO_VECTOR_MIN        record count for auto       (default 5000)
 *   MNEMO_LLM_BASE_URL      OpenAI-compatible endpoint   (optional)
 *   MNEMO_LLM_MODEL         model id                     (optional)
 *   MNEMO_LLM_API_KEY_ENV   env var holding the key      (default MNEMO_LLM_API_KEY)
 *   MNEMO_EMBED_BASE_URL    OpenAI-compatible /embeddings (optional)
 *   MNEMO_EMBED_MODEL       embedding model id            (optional)
 *
 * Nothing is written to stdout except protocol messages. Diagnostics go to
 * stderr, because a stray console.log corrupts the JSON-RPC stream.
 *
 * The transport is injectable on purpose: `serve()` takes a readable stream and a
 * sink, so the framing and dispatch path is testable in-process without spawning
 * a child process.
 */
import { createInterface } from 'node:readline';
import path from 'node:path';
import { Mnemo } from '../mnemo.js';
import { OpenAICompatibleLLM } from '../llm/openai.js';
import { OpenAIEmbedder } from '../retrieval/embedder.js';
import { decodeLine, handleMessage, SERVER_NAME } from './protocol.js';
export const VERSION = '0.2.0';
export function env(name) {
    const value = process.env[name];
    return value && value.trim().length > 0 ? value.trim() : undefined;
}
function stderrLog(message) {
    process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}
export function buildLlm() {
    const baseUrl = env('MNEMO_LLM_BASE_URL');
    const model = env('MNEMO_LLM_MODEL');
    if (!baseUrl || !model)
        return undefined;
    try {
        return new OpenAICompatibleLLM({
            baseUrl,
            model,
            apiKeyEnv: env('MNEMO_LLM_API_KEY_ENV') ?? 'MNEMO_LLM_API_KEY',
        });
    }
    catch (err) {
        stderrLog(`LLM disabled: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}
export function buildEmbedder() {
    const baseUrl = env('MNEMO_EMBED_BASE_URL');
    const model = env('MNEMO_EMBED_MODEL');
    if (!baseUrl || !model)
        return undefined;
    try {
        return new OpenAIEmbedder({
            baseUrl,
            model,
            apiKeyEnv: env('MNEMO_EMBED_API_KEY_ENV') ?? env('MNEMO_LLM_API_KEY_ENV') ?? 'MNEMO_LLM_API_KEY',
        });
    }
    catch (err) {
        stderrLog(`embeddings disabled: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}
export function configFromEnv() {
    const mode = env('MNEMO_VECTOR_MODE');
    const minRecords = env('MNEMO_VECTOR_MIN');
    const config = {};
    if (mode === 'off' || mode === 'auto' || mode === 'on' || minRecords) {
        config.vector = {
            mode: mode === 'off' || mode === 'on' ? mode : 'auto',
            minRecords: minRecords ? Number.parseInt(minRecords, 10) : 5000,
            blend: 0.4,
            batchSize: 64,
        };
    }
    return config;
}
/**
 * Run the line loop until the input ends.
 *
 * One JSON object per line in, one per line out. Never pretty-print: embedded
 * newlines would break framing, which is the classic way to corrupt a stdio MCP
 * server.
 */
export function serve(options) {
    const log = options.onLog ?? stderrLog;
    const ctx = { mem: options.mem, version: options.version ?? VERSION };
    const rl = createInterface({ input: options.input, crlfDelay: Infinity });
    let pending = Promise.resolve();
    rl.on('line', (line) => {
        const decoded = decodeLine(line);
        if (!decoded.ok) {
            options.output.write(`${JSON.stringify(decoded.response)}\n`);
            return;
        }
        // Serialise handling so responses keep their request order.
        pending = pending
            .then(() => handleMessage(ctx, decoded.value))
            .then((response) => {
            if (response)
                options.output.write(`${JSON.stringify(response)}\n`);
        })
            .catch((err) => {
            log(`handler crashed: ${err instanceof Error ? err.message : String(err)}`);
        });
    });
    return new Promise((resolve) => {
        rl.on('close', () => {
            void pending.then(() => {
                log('stdin closed, exiting');
                resolve();
            });
        });
    });
}
export async function startServer() {
    const dir = path.resolve(env('MNEMO_DIR') ?? './.mnemo');
    let mem;
    try {
        mem = await Mnemo.open(dir, {
            config: configFromEnv(),
            llm: buildLlm(),
            embedder: buildEmbedder(),
            agentPrincipal: env('MNEMO_AGENT_PRINCIPAL') ?? 'agent:self',
            userPrincipal: env('MNEMO_USER_PRINCIPAL'),
        });
    }
    catch (err) {
        stderrLog(`failed to open store at ${dir}: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
    stderrLog(`ready · store=${dir} · records=${mem.metrics().total} · vectors=${mem.vectorStatus().enabled}`);
    await serve({ mem, input: process.stdin, output: process.stdout });
}
// Only auto-start when executed directly, so tests and imports never bind stdio.
const invokedDirectly = process.argv[1] !== undefined && /server\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
    startServer().catch((err) => {
        stderrLog(`fatal: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    });
}
//# sourceMappingURL=server.js.map