import tseslint from 'typescript-eslint';

const SRC = ['src/**/*.ts'];
const TOOLS = ['tests/**/*.mjs', 'scripts/**/*.mjs', '*.mjs'];

const asArray = (value) => (Array.isArray(value) ? value : [value]);
const strictForSrc = asArray(tseslint.configs.strictTypeChecked).map((config) => ({
  ...config,
  files: SRC,
}));
const untypedForTools = asArray(tseslint.configs.disableTypeChecked).map((config) => ({
  ...config,
  files: TOOLS,
}));

export default tseslint.config(
  { ignores: ['dist/', '.test-build/', 'node_modules/', 'coverage/'] },
  ...strictForSrc,
  {
    files: SRC,
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        projectService: true,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // S-2：禁止直接使用 console，统一走 shared/logger 脱敏封装
      'no-console': 'error',
      // M-4：禁止远程代码
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['src/ui/**/*.ts', 'src/content/**/*.ts', 'src/core/**/*.ts'],
    rules: {
      // E-2：ui / content / core 禁止 import 具体适配器
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/adapters/**', '../adapters/**', './adapters/**'],
              message: 'E-2: ui / content / core 禁止依赖具体适配器',
            },
          ],
        },
      ],
    },
  },
  ...untypedForTools,
  {
    files: TOOLS,
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        globalThis: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        document: 'readonly',
        MutationObserver: 'readonly',
        NodeFilter: 'readonly',
        HTMLInputElement: 'readonly',
        Event: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
);
