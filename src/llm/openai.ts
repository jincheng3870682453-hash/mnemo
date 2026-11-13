/**
 * Adapter for any OpenAI-compatible chat-completions endpoint.
 *
 * Works unchanged with DeepSeek, Zhipu GLM, Moonshot, vLLM, Ollama's OpenAI shim,
 * etc. The base URL and model are the only things that differ. No SDK.
 *
 * The API key is read from the caller or from an environment variable and is
 * never logged, serialised, or included in error messages.
 */

import type { LLM, LLMRequest } from './types.js';

export interface OpenAICompatibleOptions {
  /** e.g. https://api.deepseek.com/v1 — the `/chat/completions` suffix is appended. */
  baseUrl: string;
  model: string;
  /** Prefer an explicit value; the env fallback is a convenience, not a contract. */
  apiKey?: string;
  /** Environment variable to read the key from when `apiKey` is absent. */
  apiKeyEnv?: string;
  /** Extra headers, e.g. for gateways that need routing metadata. */
  headers?: Record<string, string>;
  /** Milliseconds before the request is aborted. Default 60s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export class OpenAICompatibleLLM implements LLM {
  readonly name: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    const base = options.baseUrl.replace(/\/+$/, '');
    this.endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    this.model = options.model;
    const envName = options.apiKeyEnv ?? 'OPENAI_API_KEY';
    this.apiKey = options.apiKey ?? process.env[envName] ?? '';
    if (!this.apiKey) {
      throw new Error(`no API key: pass options.apiKey or set ${envName}`);
    }
    this.extraHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.name = `openai-compatible:${options.model}`;
  }

  async complete(request: LLMRequest): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    messages.push({ role: 'user', content: request.prompt });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens ?? 512,
      temperature: request.temperature ?? 0.2,
    };
    if (request.json) body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Never echo the request body or headers: they contain the key.
        throw new Error(`LLM request failed with HTTP ${res.status}`);
      }

      const data = (await res.json()) as ChatCompletionResponse;
      if (data.error?.message) throw new Error(`LLM error: ${data.error.message}`);
      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
}
