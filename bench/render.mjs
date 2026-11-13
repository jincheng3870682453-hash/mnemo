#!/usr/bin/env node
/**
 * Render `bench/out/report.json` into SVG charts and a self-contained report.
 *
 *   npm run bench:render
 *
 * Zero dependencies on purpose: the project's whole premise is that a memory
 * layer should not drag a toolchain behind it, and charts are not a reason to
 * start. The SVGs are hand-emitted, so they render on GitHub without a build.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve(process.cwd(), 'docs/benchmark');

const COLOR = {
  bg: '#0d1117',
  panel: '#161b22',
  grid: '#21262d',
  text: '#e6edf3',
  muted: '#8b949e',
  naive: '#f87171',
  mnemo: '#34d399',
  accent: '#22d3ee',
  gold: '#fbbf24',
  violet: '#a78bfa',
};

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function svgWrap(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
<rect width="${width}" height="${height}" rx="14" fill="${COLOR.bg}"/>
${body}
</svg>`;
}

function header(width, title, subtitle) {
  return `<text x="28" y="34" font-family="ui-sans-serif, system-ui, 'Segoe UI', sans-serif" font-size="18" font-weight="700" fill="${COLOR.text}">${esc(title)}</text>
<text x="28" y="56" font-family="ui-sans-serif, system-ui, 'Segoe UI', sans-serif" font-size="12" fill="${COLOR.muted}">${esc(subtitle)}</text>`;
}

const nice = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));
const pct = (v) => `${(v * 100).toFixed(1)}%`;

/**
 * Two-series grouped bar chart.
 * categories: string[]; a/b: number[]; format: (n) => string
 */
function groupBar({ title, subtitle, categories, a, b, labelA, labelB, format = nice, width = 760, height = 400, single = false }) {
  const m = { top: 82, right: 28, bottom: 44, left: 64 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;
  const max = Math.max(...a, ...(single ? [] : b), 1) * 1.18;
  const y = (v) => m.top + ph - (v / max) * ph;

  let body = header(width, title, subtitle);
  // grid + y labels
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const yy = y(v);
    body += `<line x1="${m.left}" y1="${yy}" x2="${width - m.right}" y2="${yy}" stroke="${COLOR.grid}" stroke-width="1"/>`;
    body += `<text x="${m.left - 10}" y="${yy + 4}" text-anchor="end" font-family="ui-monospace, monospace" font-size="10" fill="${COLOR.muted}">${esc(format(v))}</text>`;
  }

  const gw = pw / categories.length;
  const bw = Math.min(88, gw * 0.3);
  categories.forEach((cat, i) => {
    const cx = m.left + gw * i + gw / 2;
    const va = a[i];
    if (single) {
      body += `<rect x="${cx - bw / 2}" y="${y(va)}" width="${bw}" height="${m.top + ph - y(va)}" rx="4" fill="${COLOR.accent}" opacity="0.9"/>`;
      body += `<text x="${cx}" y="${y(va) - 8}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" font-weight="600" fill="${COLOR.accent}">${esc(format(va))}</text>`;
    } else {
      const vb = b[i];
      body += `<rect x="${cx - bw - 6}" y="${y(va)}" width="${bw}" height="${m.top + ph - y(va)}" rx="4" fill="${COLOR.naive}" opacity="0.9"/>`;
      body += `<rect x="${cx + 6}" y="${y(vb)}" width="${bw}" height="${m.top + ph - y(vb)}" rx="4" fill="${COLOR.mnemo}" opacity="0.95"/>`;
      body += `<text x="${cx - bw / 2 - 6}" y="${y(va) - 8}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" font-weight="600" fill="${COLOR.naive}">${esc(format(va))}</text>`;
      body += `<text x="${cx + bw / 2 + 6}" y="${y(vb) - 8}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" font-weight="600" fill="${COLOR.mnemo}">${esc(format(vb))}</text>`;
    }
    body += `<text x="${cx}" y="${height - 16}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="${COLOR.text}">${esc(cat)}</text>`;
  });

  if (!single) {
    body += `<circle cx="${width - 190}" cy="30" r="5" fill="${COLOR.naive}"/><text x="${width - 178}" y="34" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="${COLOR.muted}">${esc(labelA)}</text>`;
    body += `<circle cx="${width - 96}" cy="30" r="5" fill="${COLOR.mnemo}"/><text x="${width - 84}" y="34" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="${COLOR.muted}">${esc(labelB)}</text>`;
  } else {
    body += `<circle cx="${width - 120}" cy="30" r="5" fill="${COLOR.accent}"/><text x="${width - 108}" y="34" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="${COLOR.muted}">${esc(labelA)}</text>`;
  }

  return svgWrap(width, height, body);
}

/**
 * Two-series line chart.
 * xs: number[]; a/b: number[]
 */
function lineChart({ title, subtitle, xs, a, b, labelA, labelB, width = 760, height = 400 }) {
  const m = { top: 82, right: 28, bottom: 46, left: 64 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;
  const max = Math.max(...a, ...b, 1) * 1.18;
  const y = (v) => m.top + ph - (v / max) * ph;
  const x = (i) => m.left + (pw / (xs.length - 1)) * i;

  let body = header(width, title, subtitle);
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const yy = y(v);
    body += `<line x1="${m.left}" y1="${yy}" x2="${width - m.right}" y2="${yy}" stroke="${COLOR.grid}" stroke-width="1"/>`;
    body += `<text x="${m.left - 10}" y="${yy + 4}" text-anchor="end" font-family="ui-monospace, monospace" font-size="10" fill="${COLOR.muted}">${esc(nice(v))}</text>`;
  }

  const path = (vals, color) => {
    const d = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round"/>`;
  };
  body += path(a, COLOR.naive);
  body += path(b, COLOR.mnemo);
  xs.forEach((turn, i) => {
    body += `<circle cx="${x(i)}" cy="${y(a[i])}" r="4" fill="${COLOR.bg}" stroke="${COLOR.naive}" stroke-width="2"/>`;
    body += `<circle cx="${x(i)}" cy="${y(b[i])}" r="4" fill="${COLOR.bg}" stroke="${COLOR.mnemo}" stroke-width="2"/>`;
    body += `<text x="${x(i)}" y="${height - 16}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="${COLOR.muted}">${turn}</text>`;
  });
  // annotate the crossing (linear interpolation between samples)
  const idx = xs.findIndex((_, i) => a[i] > b[i]);
  if (idx > 0) {
    const t = (b[idx - 1] - a[idx - 1]) / (a[idx] - b[idx] - (a[idx - 1] - b[idx - 1]));
    const cross = Math.round(xs[idx - 1] + t * (xs[idx] - xs[idx - 1]));
    body += `<text x="${m.left + pw / 2}" y="${m.top + 18}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="${COLOR.gold}">crossover ≈ ${cross} turns</text>`;
  }

  body += `<text x="${m.left + pw / 2}" y="${height - 2}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" fill="${COLOR.muted}">turns in session</text>`;
  body += `<circle cx="${width - 190}" cy="30" r="5" fill="${COLOR.naive}"/><text x="${width - 178}" y="34" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="${COLOR.muted}">${esc(labelA)}</text>`;
  body += `<circle cx="${width - 96}" cy="30" r="5" fill="${COLOR.mnemo}"/><text x="${width - 84}" y="34" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="${COLOR.muted}">${esc(labelB)}</text>`;
  return svgWrap(width, height, body);
}

function card(label, value, note, color) {
  return `<div class="card"><div class="card-label">${esc(label)}</div><div class="card-value" style="color:${color}">${esc(value)}</div><div class="card-note">${esc(note)}</div></div>`;
}

async function main() {
  const report = JSON.parse(await readFile(path.resolve(process.cwd(), 'bench/out/report.json'), 'utf8'));
  await mkdir(OUT, { recursive: true });

  const t = report.totals;
  const q = report.corpus.queries;

  const tokensSvg = groupBar({
    title: '整段会话的上下文总开销',
    subtitle: `naive 每轮重发全文 · mnemo 只放指针 · ${report.corpus.turns} turns, ${report.corpus.dialogues} dialogues`,
    categories: ['context tokens (whole session)'],
    a: [t.naive.ctxTokens],
    b: [t.mnemo.ctxTokens],
    labelA: 'naive transcript',
    labelB: 'mnemo pointers',
    format: (v) => nice(v),
  });

  const accSvg = groupBar({
    title: '同一批问题的检索准确率',
    subtitle: `${q} labelled queries · top-1 / top-3 hit`,
    categories: ['recall@1', 'recall@3'],
    a: [t.naive.hit1 / q, t.naive.hit3 / q],
    b: [t.mnemo.hit1 / q, t.mnemo.hit3 / q],
    labelA: 'naive BM25 over turns',
    labelB: 'mnemo memory index',
    format: (v) => pct(v),
  });

  const probeSvg = groupBar({
    title: '“我记不记得” 探针 vs 全量检索',
    subtitle: `${q} queries · feeling-of-knowing line vs full recall`,
    categories: ['feeling-of-knowing', 'full recall'],
    a: [t.probe.probeTokens, t.probe.recallTokens],
    b: [0, 0],
    labelA: 'tokens (lower is better)',
    labelB: '',
    format: nice,
    single: true,
  });

  const curveSvg = lineChart({
    title: '每轮上下文成本随会话增长',
    subtitle: 'analytical projection from corpus averages; 8-turn point matches the measurement',
    xs: report.costCurve.map((p) => p.turns),
    a: report.costCurve.map((p) => p.naive),
    b: report.costCurve.map((p) => p.mnemo),
    labelA: 'naive (linear)',
    labelB: 'mnemo (flat)',
  });

  const files = {
    'tokens.svg': tokensSvg,
    'accuracy.svg': accSvg,
    'probe.svg': probeSvg,
    'cost-curve.svg': curveSvg,
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(OUT, name), content, 'utf8');
  }

  const probeSaving = t.probe.recallTokens === 0 ? 0 : 1 - t.probe.probeTokens / t.probe.recallTokens;

  const rows = report.byDomain
    .map(
      (d) =>
        `<tr><td>${esc(d.domain)}</td><td>${d.dialogues}</td><td>${d.queries}</td><td>${pct(d.naiveHit1 / Math.max(1, d.queries))}</td><td>${pct(d.mnemoHit1 / Math.max(1, d.queries))}</td></tr>`,
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>mnemo benchmark report</title>
<style>
  :root{--bg:#0b1020;--panel:#121a2b;--line:#22304a;--text:#e6edf3;--muted:#8b949e;--green:#34d399;--red:#f87171;--cyan:#22d3ee;--gold:#fbbf24}
  *{box-sizing:border-box}
  body{margin:0;color:var(--text);font:14px/1.6 ui-sans-serif,system-ui,"Segoe UI",sans-serif;
    background:
      radial-gradient(1100px 520px at 12% -10%, rgba(34,211,238,.13), transparent 60%),
      radial-gradient(900px 480px at 108% 4%, rgba(167,139,250,.15), transparent 55%),
      linear-gradient(165deg,#0e1525 0%,#131c31 48%,#0c1220 100%);
    background-attachment:fixed;}
  main{max-width:1040px;margin:0 auto;padding:48px 20px 64px}
  h1{font-size:28px;margin:0 0 6px}
  .sub{color:var(--muted);margin:0 0 28px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:28px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}
  .card-label{color:var(--muted);font-size:12px;letter-spacing:.04em;text-transform:uppercase}
  .card-value{font:700 30px/1.2 ui-monospace,monospace;margin:8px 0 4px}
  .card-note{color:var(--muted);font-size:12px}
  figure{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px;margin:0 0 18px}
  figure img{width:100%;height:auto;display:block;border-radius:10px}
  figcaption{color:var(--muted);font-size:12px;padding:10px 8px 4px}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
  th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--line)}
  th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  code{background:#0b1017;border:1px solid var(--line);border-radius:6px;padding:2px 6px;font-family:ui-monospace,monospace;font-size:12px}
  .foot{color:var(--muted);font-size:12px;margin-top:28px}
</style></head>
<body><main>
  <h1>mnemo · dialogue benchmark</h1>
  <p class="sub">${report.corpus.dialogues} dialogues · ${report.corpus.turns} turns · ${report.corpus.facts} facts · ${report.corpus.queries} labelled queries · generated ${esc(report.generatedAt.slice(0, 19))}Z</p>

  <div class="grid">
    ${card('recall@1', pct(t.mnemo.hit1 / q), `naive ${pct(t.naive.hit1 / q)}`, COLOR.mnemo)}
    ${card('recall@3', pct(t.mnemo.hit3 / q), `naive ${pct(t.naive.hit3 / q)}`, COLOR.mnemo)}
    ${card('tokens / turn', t.mnemo.tokensPerTurn.toFixed(1), `naive ${t.naive.tokensPerTurn.toFixed(1)} · 8-turn corpus`, COLOR.gold)}
    ${card('probe saving', pct(probeSaving), `${t.probe.probeTokens} vs ${t.probe.recallTokens} tok`, COLOR.accent)}
  </div>

  <figure><img src="tokens.svg" alt="context tokens"/><figcaption>Short dialogues are where mnemo's fixed boot cost is largest; the projection below shows where it crosses.</figcaption></figure>
  <figure><img src="accuracy.svg" alt="recall"/><figcaption>Same questions, same corpus. The naive baseline gets the whole transcript and still misses.</figcaption></figure>
  <figure><img src="probe.svg" alt="probe"/><figcaption>Feeling-of-knowing is a single line that costs less than deciding to search.</figcaption></figure>
  <figure><img src="cost-curve.svg" alt="cost curve"/><figcaption>Analytical projection, not extra measurements: naive is linear in turns, mnemo is flat.</figcaption></figure>

  <h2>按领域（recall@1）</h2>
  <table><thead><tr><th>domain</th><th>dialogues</th><th>queries</th><th>naive</th><th>mnemo</th></tr></thead><tbody>
  ${rows}
  </tbody></table>

  <p class="foot">Reproduce: <code>npm run bench:dialogue</code> then <code>npm run bench:render</code>. Corpus: <code>bench/data/dialogues.jsonl</code> (curated, labelled by hand). The naive baseline resends the full transcript plus the same system prompt every turn. Numbers are estimates from mnemo's own tokeniser, not a provider's tokenizer.</p>
</main></body></html>`;

  await writeFile(path.join(OUT, 'report.html'), html, 'utf8');
  console.log(`wrote ${Object.keys(files).length} svg + report.html to docs/benchmark/`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
