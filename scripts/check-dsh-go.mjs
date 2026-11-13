/**
 * Offline checker for the DSH Go plugin.
 *
 *   node scripts/check-dsh-go.mjs
 *
 * Two halves:
 *
 *   1. Static manifest lint against the constraints documented in the official
 *      `dsh-go-plugin` skill (slot caps, label lengths, id charset/uniqueness,
 *      serialized size, cross-references between strip/actions and panels).
 *   2. A load-and-tap smoke test: instantiate the plugin with a fake bridge,
 *      invoke each handler, and assert the shapes it returns.
 *
 * The authoritative checker is the app's own kit (`kit/bin/check.mjs`, needs
 * $DSH_HOME/skills). This script exists so CI can catch the same class of
 * mistake without a phone, and it deliberately re-implements the limits from the
 * documentation rather than guessing them.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkgDir = path.join(root, 'dsh-go');

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const chars = (value) => Array.from(String(value)).length;

/** Text may be a string or { zh, en }; every locale must respect the limit. */
function checkText(where, value, limit, required = true) {
  if (value === undefined) {
    if (required) fail(`${where}: missing`);
    return;
  }
  if (typeof value === 'string') {
    if (chars(value) > limit) fail(`${where}: ${chars(value)} chars > ${limit}`);
    return;
  }
  if (typeof value !== 'object' || value === null) {
    fail(`${where}: must be a string or { zh, en }`);
    return;
  }
  const locales = Object.keys(value);
  if (locales.length === 0) fail(`${where}: empty locale object`);
  for (const locale of locales) {
    if (typeof value[locale] !== 'string') {
      fail(`${where}.${locale}: must be a string`);
      continue;
    }
    if (chars(value[locale]) > limit) {
      fail(`${where}.${locale}: ${chars(value[locale])} chars > ${limit}`);
    }
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const SLOTS = {
  'composer.actions': { max: 2, labelLimit: 10 },
  'message.actions': { max: 2, labelLimit: 12 },
  'composer.strip': { max: 1, labelLimit: 24, textField: true },
  panels: { max: 4, labelLimit: 16, textField: 'title' },
  'composer.tools': { max: 2, labelLimit: 8 },
  'session.actions': { max: 2, labelLimit: 12 },
  'turn.note': { max: 1, labelLimit: 16 },
};
const WANTS = new Set(['draft', 'clipboard', 'message']);
const PLACEMENTS = new Set(['session.tab', 'features', 'chat.panel']);
const EFFECTS = new Set(['insert', 'command', 'open', 'link', 'toast', 'copy']);

async function lintManifest() {
  const raw = await readFile(path.join(pkgDir, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw);

  if (!pkg.name) fail('package.json: missing name');
  if (pkg.type !== 'module') fail('package.json: type must be "module"');
  if (!pkg.main) fail('package.json: missing main');
  if (pkg.main && !pkg.files?.some((f) => pkg.main.startsWith(f.replace(/\/$/, '')))) {
    warn(`package.json: main "${pkg.main}" is not covered by files`);
  }
  if (!pkg.engines?.dsh) fail('package.json: missing engines.dsh');
  if (!pkg.dsh?.bundle?.patch) fail('package.json: missing dsh.bundle.patch');

  // cordis.patch.yml must name the package.
  if (pkg.dsh?.bundle?.patch) {
    const patchPath = path.join(pkgDir, pkg.dsh.bundle.patch);
    try {
      const patch = await readFile(patchPath, 'utf8');
      if (!patch.includes(`name: ${pkg.name}`)) {
        fail(`cordis.patch.yml: must contain "name: ${pkg.name}"`);
      }
    } catch {
      fail(`dsh.bundle.patch points at a missing file: ${pkg.dsh.bundle.patch}`);
    }
  }

  const manifest = pkg.dshGo;
  if (!manifest) {
    fail('package.json: missing dshGo manifest');
    return pkg;
  }

  if (manifest.v !== 1) fail(`dshGo.v: expected 1, got ${String(manifest.v)}`);
  checkText('dshGo.title', manifest.title, 24, false);

  for (const want of manifest.wants ?? []) {
    if (!WANTS.has(want)) fail(`dshGo.wants: unknown capability "${want}"`);
  }

  const size = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
  if (size > 16 * 1024) fail(`dshGo: serialized ${size} bytes > 16384`);

  const contributes = manifest.contributes ?? {};
  const ids = new Map();
  const panelIds = new Set((contributes.panels ?? []).map((p) => p.id));

  for (const [slotName, items] of Object.entries(contributes)) {
    const spec = SLOTS[slotName];
    if (!spec) {
      warn(`contributes.${slotName}: unknown slot (ignored by the bridge)`);
      continue;
    }
    if (!Array.isArray(items)) {
      fail(`contributes.${slotName}: must be an array`);
      continue;
    }
    if (items.length > spec.max) {
      fail(`contributes.${slotName}: ${items.length} entries > ${spec.max}`);
    }
    for (const [index, item] of items.entries()) {
      const where = `contributes.${slotName}[${index}]`;

      if (typeof item.id !== 'string' || !ID_RE.test(item.id)) {
        fail(`${where}.id: "${item.id}" does not match ${ID_RE}`);
      } else if (ids.has(item.id)) {
        fail(`${where}.id: "${item.id}" already used by ${ids.get(item.id)}`);
      } else {
        ids.set(item.id, where);
      }

      const textField = spec.textField === true ? 'text' : spec.textField ?? 'label';
      // composer.strip may omit text (the handler fills it in), so only check
      // the limit when it is declared.
      checkText(`${where}.${textField}`, item[textField], spec.labelLimit, textField !== 'text');

      if (item.placement) {
        for (const p of item.placement) {
          if (!PLACEMENTS.has(p)) fail(`${where}.placement: unknown "${p}"`);
        }
      }

      // strip/panel cross-references
      if (slotName === 'composer.strip' && item.panel && !panelIds.has(item.panel)) {
        fail(`${where}.panel: "${item.panel}" is not a declared panel`);
      }

      // static effects
      if (item.effect) {
        const keys = Object.keys(item.effect);
        for (const key of keys) {
          if (!EFFECTS.has(key)) fail(`${where}.effect: unknown effect "${key}"`);
        }
        if (typeof item.effect.open === 'string' && item.effect.open.startsWith('panel:')) {
          const target = item.effect.open.slice('panel:'.length);
          if (!panelIds.has(target)) fail(`${where}.effect.open: no panel "${target}"`);
        }
      }
    }
  }

  if (!contributes['composer.actions'] && !contributes.panels) {
    warn('plugin contributes nothing visible; is that intended?');
  }

  return pkg;
}

/** A bridge stub that records registrations and lets us tap them. */
function fakeBridge() {
  const actions = new Map();
  const strips = new Map();
  const panels = new Map();
  return {
    actions,
    strips,
    panels,
    on: (id, fn) => actions.set(id, fn),
    strip: (id, fn) => strips.set(id, fn),
    panel: (id, spec) => panels.set(id, spec),
  };
}

async function smoke(pkg) {
  const home = await mkdtemp(path.join(tmpdir(), 'mnemo-dsh-'));
  process.env.DSH_HOME = home;

  try {
    const entry = path.join(pkgDir, pkg.main);
    const mod = await import(pathToFileURL(entry).href);

    if (typeof mod.apply !== 'function') fail('lib: missing apply(ctx)');
    if (mod.name !== pkg.name) fail(`lib: name "${mod.name}" != package name "${pkg.name}"`);

    const bridge = fakeBridge();
    mod.apply({
      inject: (deps, fn) => {
        if (deps.length !== 1 || deps[0] !== 'dshGo') {
          fail(`lib: inject() called with ${JSON.stringify(deps)}; expected ['dshGo']`);
        }
        fn({ dshGo: bridge });
      },
    });

    // Every declared action must have a handler (or a static effect).
    for (const action of pkg.dshGo.contributes['composer.actions'] ?? []) {
      if (!action.effect && !bridge.actions.has(action.id)) {
        fail(`lib: no handler registered for action "${action.id}"`);
      }
    }
    for (const strip of pkg.dshGo.contributes['composer.strip'] ?? []) {
      if (!bridge.strips.has(strip.id)) fail(`lib: no handler for strip "${strip.id}"`);
    }
    for (const panel of pkg.dshGo.contributes.panels ?? []) {
      const spec = bridge.panels.get(panel.id);
      if (!spec) {
        fail(`lib: no handler for panel "${panel.id}"`);
        continue;
      }
      if (typeof spec.view !== 'function') fail(`lib: panel "${panel.id}" has no view()`);
      if (typeof spec.data !== 'function') fail(`lib: panel "${panel.id}" has no data()`);
    }

    // Tap remember with an empty draft: must refuse without throwing.
    const remember = bridge.actions.get('remember');
    if (remember) {
      const empty = await remember({ draft: '   ' }, { surface: 'composer', id: 'remember', locale: 'zh' });
      if (!empty?.toast) fail('remember(empty): expected a toast');

      const wrote = await remember(
        { draft: '金呈不喜欢客套开场白' },
        { surface: 'composer', id: 'remember', locale: 'zh' },
      );
      if (!wrote?.toast) fail('remember(draft): expected a toast');
      if (wrote?.insert) fail('remember: must not insert into the composer');
    }

    // Give the fire-and-forget write a moment, then recall it back.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const recall = bridge.actions.get('recall');
    if (recall) {
      const deferred = recall({ draft: '客套' }, { surface: 'composer', id: 'recall', locale: 'zh' });
      if (!deferred?.pending) fail('recall: expected a pending effect');
      else {
        const result = await deferred.result(new AbortController().signal);
        if (!result?.insert && !result?.toast) fail('recall: result must carry insert or toast');
        if (result?.insert && chars(result.insert) > 2000) fail('recall: insert exceeds 2000 chars');
      }

      const empty = recall({ draft: '' }, { surface: 'composer', id: 'recall', locale: 'zh' });
      if (!empty?.open) fail('recall(empty): expected open:panel');
    }

    // Strip must emit a line within the 24-character cap.
    const strip = bridge.strips.get('status');
    if (strip) {
      let emitted = null;
      const dispose = strip({}, (next) => { emitted = next; }, { protocol: 1, locale: 'zh' });
      if (!emitted?.text) fail('strip: emitted nothing');
      if (emitted && chars(emitted.text) > 24) fail(`strip: "${emitted.text}" exceeds 24 chars`);
      if (typeof dispose === 'function') dispose();
    }

    // Panel must produce a renderable view and a data payload.
    const panel = bridge.panels.get('memory');
    if (panel) {
      const view = panel.view({}, { protocol: 1, locale: 'zh', app: '0.0.0', surfaces: [], components: [] });
      if (!view || view.type !== 'stack') fail('panel view: root should be a stack');
      const json = JSON.stringify(view);
      if (Buffer.byteLength(json, 'utf8') > 32 * 1024) fail('panel view: exceeds 32 KiB');

      let data = null;
      const dispose = panel.data({}, (next) => { data = next; }, { protocol: 1, locale: 'zh' });
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!data) fail('panel data: emitted nothing');
      if (data && typeof data.records !== 'number') fail('panel data: missing records metric');
      if (data && !Array.isArray(data.items)) fail('panel data: items must be an array');
      if (typeof dispose === 'function') dispose();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function main() {
  const pkg = await lintManifest();
  if (errors.length === 0) await smoke(pkg);

  for (const w of warnings) console.log(`warn  ${w}`);
  for (const e of errors) console.error(`error ${e}`);

  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s)`);
    process.exit(1);
  }
  console.log(`\ndsh-go plugin ok (${warnings.length} warning(s))`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
