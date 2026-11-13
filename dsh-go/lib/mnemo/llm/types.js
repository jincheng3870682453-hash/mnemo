/**
 * The only coupling point between mnemo and a model provider.
 *
 * Everything else in the library is deterministic. Gist extraction is the single
 * place a model is useful, and even that degrades to a heuristic when no model is
 * configured — so the library is fully functional offline.
 */
/** No model. `complete` returns an empty string, which callers treat as "use the heuristic". */
export class NullLLM {
    name = 'null';
    async complete() {
        return '';
    }
}
//# sourceMappingURL=types.js.map