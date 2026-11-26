// The SDK's types as one file, for a team's own layer package (#508).
//
// A site layer imports from '@mrstudio/sdk'. The app supplies the code when it loads the
// layer, but a package outside this repository has nothing to type-check against. This writes
// every declaration of the SDK into crates/mrs-cli/templates/layer/types/mrstudio-sdk.d.ts,
// which `mrstudio layer new` and `mrstudio layer build` put into the package.
//
//   node scripts/types.mjs           writes the file
//   node scripts/types.mjs --check   fails when the file is out of date, or when the layer
//                                    template does not type-check on its own with it
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sdk = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(sdk, '../..');
const template = join(repo, 'crates/mrs-cli/templates/layer');
const target = join(template, 'types/mrstudio-sdk.d.ts');

function declarations() {
  let out = '';
  const program = ts.createProgram([join(sdk, 'src/index.ts')], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.AMD,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    declaration: true,
    emitDeclarationOnly: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    stripInternal: true,
    outFile: 'sdk.d.ts',
  });
  program.emit(undefined, (_name, text) => (out += text));
  if (!out) throw new Error('the SDK produced no declarations');
  // Each source file is a module named by its path ("types", "blocks/geo"). Put them under
  // the package's name, so they cannot meet a module of the team's own, and make the index
  // the package itself.
  const names = new Set([...out.matchAll(/^declare module "([^"]+)"/gm)].map((m) => m[1]));
  const named = (name) => (name === 'index' ? '@mrstudio/sdk' : `@mrstudio/sdk/${name}`);
  out = out.replace(/(^declare module |\bfrom |\bimport\()"([^"]+)"/gm, (all, before, name) => (names.has(name) ? `${before}"${named(name)}"` : all));
  return [
    '// The types of @mrstudio/sdk, written by MR Studio (`mrstudio layer new`, `mrstudio layer build`).',
    '// Do not edit: the next build writes it again from the installed app. The code itself comes',
    '// from the app that loads the layer.',
    '',
    out.replace(/\r\n/g, '\n').trimEnd(),
    '',
  ].join('\n');
}

/** The layer template as `mrstudio layer new` writes it, in a folder outside the workspace, type-checked on its own. */
function checkTemplate(types) {
  const dir = mkdtempSync(join(tmpdir(), 'mrstudio-layer-'));
  try {
    const copy = (from, to) => {
      for (const name of readdirSync(from)) {
        const [source, dest] = [join(from, name), join(to, name)];
        if (statSync(source).isDirectory()) {
          mkdirSync(dest, { recursive: true });
          copy(source, dest);
        } else if (/\.(ts|json)$/.test(name) && !name.endsWith('.d.ts')) {
          writeFileSync(dest, readFileSync(source, 'utf8').replaceAll('__ID__', 'my-layer').replaceAll('__NAME__', 'My layer'));
        }
      }
    };
    copy(template, dir);
    mkdirSync(join(dir, 'types'), { recursive: true });
    writeFileSync(join(dir, 'types/mrstudio-sdk.d.ts'), types);
    execFileSync(process.execPath, [join(sdk, 'node_modules/typescript/bin/tsc'), '-p', dir], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`the layer template does not type-check on its own:\n${e.stdout ?? e}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const types = declarations();
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // Missing: reported below.
  }
  if (current !== types) {
    console.error('crates/mrs-cli/templates/layer/types/mrstudio-sdk.d.ts is not what the SDK exports now.\nRun `pnpm --filter @mrstudio/sdk types` and commit the file.');
    process.exit(1);
  }
  checkTemplate(types);
  console.log('The layer template type-checks on its own against the SDK types it ships with.');
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, types);
  checkTemplate(types);
  console.log(`Wrote ${target} (${Math.round(types.length / 1024)} KB).`);
}

