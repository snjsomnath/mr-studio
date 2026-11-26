// Promise checks for the code that runs in the windows (#264): a promise nobody awaits or
// catches is how errors end up invisible (#259, #260). `void promise` says on purpose; a
// `.catch()` should report or say why it ignores. Run with `pnpm lint`.
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/target/**', 'packages/**/*.js', 'packages/**/*.cjs', 'packages/**/*.mjs', 'apps/studio/src-tauri/gen/**', 'sites/**', 'samples/**', 'docs/**'] },
  // The plain JavaScript no type check reads (#544): the app's own pages, the scripts the
  // shell puts into windows, and the scripts that build and release. A name that does not
  // exist, or one nobody uses, is an error here because nothing else would say so.
  {
    files: ['apps/studio/ui/**/*.js', 'apps/studio/src-tauri/src/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', vars: 'local' }] },
  },
  // The Displays and settings window loads several files into one page: these names come from launcher.js.
  {
    files: ['apps/studio/ui/colour.js', 'apps/studio/ui/calibration.js', 'apps/studio/ui/updates.js', 'apps/studio/ui/cli.js'],
    languageOptions: { globals: { $: 'readonly', el: 'readonly', invoke: 'readonly', showError: 'readonly' } },
  },
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.cjs', '*.mjs', 'packages/*/scripts/**/*.mjs', 'apps/studio/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }, // the end-to-end scripts hold code that runs in the page
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] },
  },
  // Other tools' directives (`no-var` for a global declaration) stay without complaint.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['packages/runtime/src/**/*.ts', 'packages/sdk/src/**/*.ts', 'packages/layers/*/src/**/*.ts', 'packages/dashboard/src/**/*.ts', 'packages/mcp/src/**/*.ts', 'packages/join/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }],
    },
  },
);
