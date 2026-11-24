// Promise checks for the code that runs in the windows (#264): a promise nobody awaits or
// catches is how errors end up invisible (#259, #260). `void promise` says on purpose; a
// `.catch()` should report or say why it ignores. Run with `pnpm lint`.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', '**/*.cjs', '**/*.mjs', 'packages/mcp/**', 'packages/join/**'] },
  // Other tools' directives (`no-var` for a global declaration) stay without complaint.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['packages/runtime/src/**/*.ts', 'packages/sdk/src/**/*.ts', 'packages/layers/*/src/**/*.ts', 'packages/dashboard/src/**/*.ts'],
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
