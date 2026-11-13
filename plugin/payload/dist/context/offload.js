/**
 * Tool-output offloading.
 *
 * Verbose tool results (search dumps, file contents, stack traces) are the main
 * cause of context explosion in long tasks. Measured savings from offloading them
 * to disk while keeping a reference in context, from a 2026 production report:
 *
 *   WideSearch    221.3M ->  85.6M tokens  (-61.4%)   success 33%   -> 50%
 *   SWE-bench    3474.1M -> 2375.4M tokens  (-33.1%)   success 58.4% -> 64.2%
 *   AA-LCR         112.0M ->  77.3M tokens  (-31.0%)   success 44.0% -> 47.5%
 *
 * Success went *up* as tokens went down, because the noise was hurting quality,
 * not just the bill. Note the numbers are vendor-reported and task-dependent:
 * short interactions see almost no benefit, long ones see most of it.
 *
 * The replacement is one line. Not a summary — a pointer with enough hint to let
 * the model decide whether to spend a read on it.
 */
import { estimateTokens, truncate } from '../util/text.js';
import { newRef } from '../util/id.js';
/**
 * Offload `output` if it exceeds the threshold; otherwise return it unchanged.
 * Never throws on IO failure — it degrades to inline and says so.
 */
export async function maybeOffload(store, sessionId, toolName, output, options) {
    const originalTokens = estimateTokens(output);
    const untouched = {
        inline: output,
        offloaded: false,
        originalTokens,
        inlineTokens: originalTokens,
        savedTokens: 0,
    };
    if (options.thresholdTokens <= 0)
        return untouched;
    if (originalTokens <= options.thresholdTokens)
        return untouched;
    const ref = newRef(toolName);
    const previewChars = options.previewChars ?? 48;
    const firstLine = output.split('\n').find((l) => l.trim().length > 0) ?? '';
    const preview = truncate(firstLine.trim(), previewChars);
    const lineCount = output.split('\n').length;
    try {
        const abs = await store.writeSessionFile(sessionId, `offload-${ref}.txt`, output);
        const inline = `[offload:${ref}] ${toolName} · ${lineCount} 行 · ${originalTokens} tok · 首行: ${preview}\n` +
            `（用 readOffload("${ref}") 取回全文，可分页）`;
        const inlineTokens = estimateTokens(inline);
        return {
            inline,
            offloaded: true,
            ref,
            path: abs,
            originalTokens,
            inlineTokens,
            savedTokens: Math.max(0, originalTokens - inlineTokens),
        };
    }
    catch {
        return untouched;
    }
}
/**
 * Read back an offloaded output. Returns null when the ref is unknown.
 * Line ranges let the model page through a large dump instead of swallowing it.
 */
export async function readOffload(store, sessionId, ref, options = {}) {
    const raw = await store.readSessionFile(sessionId, `offload-${ref}.txt`);
    if (raw === null)
        return null;
    const lines = raw.split('\n');
    const from = Math.max(1, options.fromLine ?? 1);
    const to = Math.min(lines.length, options.toLine ?? lines.length);
    const maxChars = options.maxChars ?? 8000;
    let text = lines.slice(from - 1, to).join('\n');
    let truncated = false;
    if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
    }
    return { text, fromLine: from, toLine: to, totalLines: lines.length, truncated };
}
//# sourceMappingURL=offload.js.map