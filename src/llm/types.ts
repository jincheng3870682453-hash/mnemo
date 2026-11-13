/**
 * The only coupling point between mnemo and a model provider.
 *
 * Everything else in the library is deterministic. Gist extraction is the single
 * place a model is useful, and even that degrades to a heuristic when no model is
 * configured — so the library is fully functional offline.
 */

export interface LLMRequest {
  system?: string;
  prompt: string;
  /** Hard ceiling on generated tokens. Defaults to 512. */
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object when it supports that. */
  json?: boolean;
}

export interface LLM {
  readonly name: string;
  complete(request: LLMRequest): Promise<string>;
}

/** No model. `complete` returns an empty string, which callers treat as "use the heuristic". */
export class NullLLM implements LLM {
  readonly name = 'null';

  async complete(): Promise<string> {
    return '';
  }
}
