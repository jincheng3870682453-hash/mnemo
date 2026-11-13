/**
 * Stage the built library into the plugin payload.
 *
 * The plugin must be installable straight from this repository, so the compiled
 * output is committed. `npm run verify:plugin` rebuilds and fails on any diff,
 * which is what stops the committed payload from drifting from the source.
 *
 * Two details matter:
 *   1. `payload/dist/package.json` with `"type":"module"` — the payload may be
 *      copied outside this repo, and without it Node would treat the ESM `.js`
 *      files as CommonJS.
 *   2. No `node_modules` is copied, because there are no runtime dependencies.
 */

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const from = path.join(root, 'dist', 'src');
const to = path.join(root, 'plugin', 'payload', 'dist');

/**
 * Copy only what a runtime needs. Source maps and `.d.ts` roughly quadruple the
 * payload for no benefit: nothing in a plugin install consumes them.
 */
async function copyJs(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyJs(src, dst);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      await cp(src, dst);
    }
  }
}

async function main() {
  // Fail loudly if the build has not run: a silent empty payload is worse.
  const entry = path.join(from, 'mcp', 'server.js');
  try {
    await readFile(entry, 'utf8');
  } catch {
    throw new Error(`missing ${entry} — run "npm run build" first`);
  }

  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  await copyJs(from, to);

  await writeFile(
    path.join(to, 'package.json'),
    `${JSON.stringify({ name: 'mnemo-plugin-payload', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );

  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

  // Keep the two manifests in lockstep with the package version.
  for (const dir of ['.zcode-plugin', '.claude-plugin']) {
    const manifestPath = path.join(root, 'plugin', dir, 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.version = pkg.version;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  console.log(`staged plugin payload → ${path.relative(root, to)} (v${pkg.version})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
