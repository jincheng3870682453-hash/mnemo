// mnemo for DSH Go — a native plugin.
//
// Runs inside the DSH engine (Node). The dsh-go app draws only what
// package.json "dshGo" declares and the JSON views returned from here; it never
// executes this code. That shapes everything below: handlers return small
// effects (insert / toast / open), views return plain JSON, and no view ever
// carries a memory body — only pointers.
//
// Three surfaces, chosen because they are the cheapest way to use memory:
//   composer.strip   one line, always visible: how much is remembered
//   composer.actions write the draft, or recall against it
//   panels           the L0 list, plus a self-test button
//
// The library itself is bundled under ./mnemo (compiled output copied by
// scripts/build-plugin.mjs) so installing on a phone never needs a build step.

import { homedir } from 'node:os'
import path from 'node:path'
import { Mnemo } from './mnemo/index.js'

export const name = 'mnemo-dsh-go'

const zh = (locale) => !String(locale).startsWith('en')

/** Store lives beside the plugin data so an engine reset does not eat it. */
const STORE = path.join(
  process.env.DSH_HOME ?? path.join(homedir(), '.dsh'),
  'dsh-go',
  'memory',
)

let opening = null

function open() {
  if (!opening) {
    // A rejected promise must not be cached: one bad open would poison every
    // later tap for the lifetime of the engine.
    opening = Mnemo.open(STORE, {
      userPrincipal: process.env.MNEMO_USER_PRINCIPAL ?? 'user:me',
    }).catch((err) => {
      opening = null
      throw err
    })
  }
  return opening
}

/** What the status line shows. Kept tiny on purpose: 24 characters is the cap. */
let snapshot = { records: 0, due: 0 }
const watchers = new Set()

function notify() {
  for (const fn of watchers) {
    try {
      fn()
    } catch {
      // A broken listener must not take down the others.
    }
  }
}

async function refresh() {
  try {
    const mem = await open()
    const metrics = mem.metrics()
    snapshot = { records: metrics.total, due: metrics.pendingIntentions }
    notify()
  } catch (err) {
    log('refresh failed', err)
  }
}

function log(message, err) {
  // stdout belongs to the engine; diagnostics go to stderr.
  process.stderr.write(`[mnemo] ${message}${err ? `: ${err?.message ?? err}` : ''}\n`)
}

/** One line from the draft: the gist the model will see first. */
function gistOf(draft) {
  const firstLine = draft.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? draft
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine
}

async function rememberDraft(draft) {
  const mem = await open()
  const result = await mem.write({
    abstract: gistOf(draft),
    body: draft,
  })
  if (result.notes.length > 0) log(`attribution: ${result.notes.join('; ')}`)
  await refresh()
  return result
}

export function apply(ctx) {
  // Never ['dshGo?'] — this plugin only makes sense on a host with the bridge.
  ctx.inject(['dshGo'], (ctx) => {
    void refresh()

    // ---------------------------------------------------------- write --

    // Synchronous return: the write is queued and the toast confirms instantly.
    // Waiting on disk IO here would spend the 3-second effect window for nothing.
    ctx.dshGo.on('remember', (scope, event) => {
      const zhLocale = zh(event.locale)
      const draft = String(scope.draft ?? '').trim()
      if (draft === '') return { toast: zhLocale ? '输入框是空的' : 'Composer is empty' }
      if (draft.length > 4000) return { toast: zhLocale ? '太长了，先精简一下' : 'Too long' }

      void rememberDraft(draft).catch((err) => log('remember failed', err))
      return { toast: zhLocale ? '已记住' : 'Remembered' }
    })

    // --------------------------------------------------------- recall --

    // Deferred effect: recall is async, and its result belongs in the composer.
    ctx.dshGo.on('recall', (scope, event) => {
      const zhLocale = zh(event.locale)
      const query = String(scope.draft ?? '').trim()
      if (query === '') return { open: 'panel:memory' }

      return {
        pending: { label: zhLocale ? '正在回想' : 'Recalling', timeoutMs: 20_000 },
        result: async (signal) => {
          const mem = await open()

          // The probe answers "do I know?" for one line. When the honest answer
          // is no, say so instead of spending a full recall.
          const probe = mem.feel(query)
          if (probe.feeling === 'no') {
            return { toast: zhLocale ? '没有相关的记忆' : 'Nothing relevant' }
          }

          const lines = await mem.recallLines({ query, limit: 6 })
          if (signal?.aborted) return { toast: zhLocale ? '已取消' : 'Cancelled' }
          if (lines.length === 0) return { toast: zhLocale ? '没有相关的记忆' : 'Nothing relevant' }

          return {
            insert: `以下是我记得的（指针，需要细节再读）：\n${lines.join('\n')}`.slice(0, 2000),
          }
        },
      }
    })

    // ---------------------------------------------------------- strip --

    ctx.dshGo.strip('status', (scope, emit, caps) => {
      const zhLocale = zh(caps.locale)
      let stopped = false

      const tick = () => {
        if (stopped) return
        const text = zhLocale
          ? `记忆 ${snapshot.records} · 惦记 ${snapshot.due}`
          : `${snapshot.records} mem · ${snapshot.due} due`
        emit({ text: text.slice(0, 24), icon: 'note' })
      }

      watchers.add(tick)
      tick()
      const timer = setInterval(tick, 60_000)

      return () => {
        stopped = true
        watchers.delete(tick)
        clearInterval(timer)
      }
    })

    // ---------------------------------------------------------- panel --

    ctx.dshGo.panel('memory', {
      view: (scope, caps) => {
        const zhLocale = zh(caps.locale)
        return {
          v: 1,
          type: 'stack',
          title: zhLocale ? '记忆' : 'Memory',
          children: [
            {
              type: 'row',
              children: [
                { type: 'metric', label: zhLocale ? '记录' : 'Records', value: { $: 'data.records' } },
                {
                  type: 'metric',
                  label: zhLocale ? '可作依据' : 'Actionable',
                  value: { $: 'data.actionable' },
                  tone: 'good',
                },
                { type: 'metric', label: zhLocale ? '惦记' : 'Due', value: { $: 'data.due' } },
              ],
            },
            { type: 'text', text: { $: 'data.hint' }, tone: 'muted' },
            { type: 'list', items: { $: 'data.items' } },
            {
              type: 'actions',
              items: [
                {
                  label: zhLocale ? '自检' : 'Self-test',
                  action: 'selftest',
                  style: 'primary',
                },
                { label: zhLocale ? '刷新' : 'Refresh', action: 'refresh' },
              ],
            },
          ],
        }
      },

      data: (scope, emit) => {
        let stopped = false
        const tick = () => {
          if (stopped) return
          void buildSnapshot().then((payload) => {
            if (!stopped) emit(payload)
          })
        }
        tick()
        watchers.add(tick)
        return () => {
          stopped = true
          watchers.delete(tick)
        }
      },

      actions: {
        refresh: () => ({ refresh: true }),

        selftest: async (scope, event) => {
          const zhLocale = zh(event.locale)
          try {
            const mem = await open()
            const report = await mem.selfTest({ samples: 12 })
            await refresh()
            return {
              toast: zhLocale
                ? `自检 ${Math.round(report.hitRate * 100)}%`
                : `Self-test ${Math.round(report.hitRate * 100)}%`,
              refresh: true,
            }
          } catch (err) {
            log('selftest failed', err)
            return { toast: zhLocale ? '自检失败' : 'Self-test failed' }
          }
        },
      },
    })
  })
}

/**
 * The panel payload.
 *
 * Only pointers leave this function: abstract, type, age. Never a body. That is
 * the same contract the library enforces for L0, kept here because the app will
 * happily render whatever it is handed.
 */
async function buildSnapshot() {
  const mem = await open()
  const metrics = mem.metrics()

  // Recency, not retrieval: this is a "what do I remember" view, so a query or a
  // goal would wrongly filter the list down to whatever happens to match it.
  const recent = mem
    .all()
    .sort((a, b) => String(b.validFrom).localeCompare(String(a.validFrom)))
    .slice(0, 8)

  const now = Date.now()
  return {
    records: metrics.total,
    actionable: metrics.decisionEligible,
    due: metrics.pendingIntentions,
    hint:
      metrics.relayed > 0
        ? `其中 ${metrics.relayed} 条是转述，不能当作依据`
        : '所有记忆都是一手信息',
    items: recent.map((record) => {
      const days = Math.max(
        0,
        Math.round((now - new Date(record.validFrom).getTime()) / 86_400_000),
      )
      return {
        title: record.abstract,
        subtitle: `${record.type} · ${days}d`,
        trailing: record.hop > 0 ? '转述' : undefined,
      }
    }),
  }
}
