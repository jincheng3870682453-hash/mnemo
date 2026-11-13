/**
 * MCP tool surface.
 *
 * Six tools, deliberately. Tool definitions live in the cacheable prompt prefix,
 * so every extra tool is a permanent tax plus another chance for the model to
 * pick the wrong one. `due` is folded into `memory_context`, which already
 * renders the "things you are keeping an eye on" block.
 *
 * Tool descriptions are written for a model, not for a human reader: they say
 * what the tool is for, what it returns, and what it costs.
 */

import type { Mnemo } from '../mnemo.js';
import type { Cue, MemoryType } from '../types.js';
import { renderL0 } from '../retrieval/retrieve.js';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: McpTool[] = [
  {
    name: 'memory_recall',
    description:
      'Search memory. Returns L0 pointers only — one line per hit with an abstract, ' +
      'age in days, score and file path. Costs ~30 tokens per hit. To read the full ' +
      'content of a hit, call memory_read. Prefer this over guessing what you remember.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, in natural language.' },
        goal: {
          type: 'string',
          description: 'What you are trying to accomplish now. Lifts memories whose intended use matches.',
        },
        cues: {
          type: 'array',
          description:
            'Situational triggers, e.g. ["emotion:anxiety", "entity:金呈", "time:2026-11-18"]. ' +
            'A cue alone can trigger recall without any query.',
          items: { type: 'string' },
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 8.' },
        include_faint: {
          type: 'boolean',
          description: 'Include memories whose retention has decayed below the active threshold.',
        },
        probe: {
          type: 'boolean',
          description:
            'Feeling-of-knowing mode: return one line saying whether memory has anything for ' +
            'this query, and at most a pointer. Cheaper than a full recall. Use it when you are ' +
            'about to say "I do not know" and want to check first.',
        },
      },
    },
  },
  {
    name: 'memory_read',
    description:
      'Read one memory by name. depth="l1" (default) returns the outline and costs ~1/8 of ' +
      'the body; depth="l2" returns the full text. Only call this when memory_recall told ' +
      'you the memory is relevant.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Record name, as returned by memory_recall.' },
        depth: { type: 'string', enum: ['l1', 'l2'], description: 'Default l1.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'memory_write',
    description:
      'Store something worth remembering across sessions. Do not store greetings, ' +
      'confirmations or anything only useful in this turn. Write the abstract as one ' +
      'sentence that would still make sense months later, with pronouns resolved and ' +
      'relative dates turned into absolute ones.',
    inputSchema: {
      type: 'object',
      properties: {
        abstract: {
          type: 'string',
          description: 'One-line gist. This is the only part normally read back, so it must stand alone.',
        },
        body: { type: 'string', description: 'Optional longer detail, read only on demand.' },
        name: { type: 'string', description: 'Optional slug. Derived from the abstract when omitted.' },
        type: {
          type: 'string',
          enum: ['fact', 'preference', 'event', 'skill'],
          description: 'Defaults to fact.',
        },
        group: { type: 'string', description: 'Bucket, e.g. "user-tone" or "work/research".' },
        salience: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: 'How much this matters. Drives forgetting speed and ranking. Default 5.',
        },
        subject: {
          type: 'string',
          description: 'Whose preference or fact this is, e.g. "user:alice". Required for a preference to be actionable.',
        },
        hop: {
          type: 'integer',
          minimum: 0,
          description:
            'Testimony depth: 0 = first-hand, 1 = retold, 2+ = hearsay. Anything above 0 cannot change behaviour.',
        },
        future: {
          type: 'array',
          items: { type: 'string' },
          description: 'Questions this memory should answer later. Used for goal-driven recall.',
        },
      },
      required: ['abstract'],
    },
  },
  {
    name: 'memory_forget',
    description:
      'Mark a memory as no longer true. It is not deleted: it stops appearing in normal ' +
      'recall but remains queryable as of a past date, which is how the record of having ' +
      'changed your mind survives.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Record name.' },
        reason: { type: 'string', description: 'Why it no longer holds.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'memory_intend',
    description:
      'Register something to remember to do later. Fires on a timestamp or on keywords ' +
      'appearing in conversation. Surfaces automatically through memory_context.',
    inputSchema: {
      type: 'object',
      properties: {
        what: { type: 'string', description: 'The thing to remember to do.' },
        at: { type: 'string', description: 'ISO timestamp, e.g. 2026-11-18T09:00.' },
        on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords that should trigger this, e.g. ["审计","截稿"].',
        },
        salience: { type: 'integer', minimum: 1, maximum: 10, description: 'Default 7.' },
      },
      required: ['what'],
    },
  },
  {
    name: 'memory_context',
    description:
      'Build the prompt context for this turn: the resident memory index, the pending ' +
      '"things you are keeping an eye on" block, relevant pointers, and the task canvas. ' +
      'Returns a stable cacheable prefix plus a volatile suffix, with token counts.',
    inputSchema: {
      type: 'object',
      properties: {
        user_message: { type: 'string', description: 'What the user just said.' },
        system: { type: 'string', description: 'Override the system prompt.' },
        task_canvas: { type: 'string', description: 'Compact task state for long-running work.' },
      },
    },
  },
];

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function text(value: string): ToolCallResult {
  return { content: [{ type: 'text', text: value }] };
}

function json(value: unknown): ToolCallResult {
  return text(JSON.stringify(value, null, 2));
}

function asString(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const v = input[key];
  return typeof v === 'boolean' ? v : undefined;
}

function asStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const v = input[key];
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : undefined;
}

/** Normalise `["emotion:anxiety"]` or `["anxiety"]` into cues. */
function toCues(raw: string[] | undefined): Cue[] | undefined {
  if (!raw) return undefined;
  const cues: Cue[] = [];
  for (const item of raw) {
    const i = item.indexOf(':');
    if (i <= 0) {
      cues.push({ kind: 'topic', value: item });
      continue;
    }
    const kind = item.slice(0, i);
    const value = item.slice(i + 1);
    if (kind !== 'entity' && kind !== 'topic' && kind !== 'time' && kind !== 'emotion' && kind !== 'goal') {
      cues.push({ kind: 'topic', value: item });
      continue;
    }
    cues.push({ kind, value } as Cue);
  }
  return cues;
}

/**
 * Dispatch a tool call. Pure with respect to the protocol: it never touches
 * stdin/stdout, which is what makes it testable without spawning a process.
 */
export async function callTool(
  mem: Mnemo,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolCallResult> {
  switch (name) {
    case 'memory_recall': {
      if (asBoolean(input, 'probe') && asString(input, 'query')) {
        return text(mem.feelLine(asString(input, 'query') as string));
      }
      const hits = await mem.recall({
        query: asString(input, 'query'),
        goal: asString(input, 'goal'),
        cues: toCues(asStringArray(input, 'cues')),
        limit: asNumber(input, 'limit'),
        includeFaint: asBoolean(input, 'include_faint'),
      });
      if (hits.length === 0) {
        return text(
          'No relevant memories. Say so rather than inventing detail, or widen the query.',
        );
      }
      const now = new Date();
      const lines = hits.map((hit) => renderL0(hit, now));
      const blocked = hits.filter((h) => !h.decisionEligible);
      const warning =
        blocked.length > 0
          ? `\n\nNote: ${blocked.length} hit(s) are relayed rather than first-hand. Mention them if useful, but do not let them change your behaviour.`
          : '';
      return text(`${lines.join('\n')}${warning}`);
    }

    case 'memory_read': {
      const recordName = asString(input, 'name');
      if (!recordName) return { ...text('name is required'), isError: true };
      const depth = asString(input, 'depth') === 'l2' ? 'l2' : 'l1';
      const result = await mem.read(recordName, depth);
      if (!result) return { ...text(`No memory named "${recordName}".`), isError: true };
      const header = [
        `# ${result.name} (${result.tokens} tok)`,
        `attribution: ${result.attribution}`,
        result.invalidAt ? `superseded at: ${result.invalidAt}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return text(`${header}\n\n${result.body}`);
    }

    case 'memory_write': {
      const abstract = asString(input, 'abstract');
      if (!abstract) return { ...text('abstract is required'), isError: true };
      const result = await mem.write({
        abstract,
        body: asString(input, 'body') ?? abstract,
        name: asString(input, 'name') ?? '',
        type: asString(input, 'type') as MemoryType | undefined,
        group: asString(input, 'group'),
        salience: asNumber(input, 'salience'),
        subject: asString(input, 'subject') ?? null,
        hop: asNumber(input, 'hop'),
        future: asStringArray(input, 'future'),
      });
      return json({
        name: result.record.name,
        relation: result.relation,
        type: result.record.type,
        path: result.path,
        invalidated: result.invalidated,
        notes: result.notes,
      });
    }

    case 'memory_forget': {
      const recordName = asString(input, 'name');
      if (!recordName) return { ...text('name is required'), isError: true };
      const ok = await mem.forget(recordName, asString(input, 'reason') ?? '');
      return ok
        ? text(`Marked "${recordName}" as no longer true. It stays queryable as of a past date.`)
        : { ...text(`No memory named "${recordName}".`), isError: true };
    }

    case 'memory_intend': {
      const what = asString(input, 'what');
      if (!what) return { ...text('what is required'), isError: true };
      const at = asString(input, 'at');
      const on = asStringArray(input, 'on');
      if (!at && !on) {
        return { ...text('Provide either `at` (ISO timestamp) or `on` (keywords).'), isError: true };
      }
      const result = await mem.intend({
        what,
        trigger: at ? { kind: 'time', at } : { kind: 'event', keywords: on ?? [] },
        salience: asNumber(input, 'salience'),
      });
      return json({ name: result.record.name, trigger: result.record.trigger, notes: result.notes });
    }

    case 'memory_context': {
      const assembled = await mem.bootContext({
        system: asString(input, 'system'),
        userMessage: asString(input, 'user_message') ?? '',
      });
      return json({
        prefix: assembled.prefix,
        suffix: assembled.suffix,
        pending: mem.pendingLines(),
        tokens: assembled.tokens,
        warnings: assembled.warnings,
        store: mem.metrics(),
        vectors: mem.vectorStatus(),
      });
    }

    default:
      return { ...text(`Unknown tool: ${name}`), isError: true };
  }
}
