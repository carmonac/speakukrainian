import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Rules shared by every package. App configs spread this in and add their own
 * framework layer (angular-eslint for the two Angular apps).
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.angular/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Scoped to TypeScript sources on purpose. angular-eslint compiles inline
    // component templates into virtual `.html` files and lints them with its
    // own parser, which cannot answer the type questions these rules ask.
    files: ['**/*.ts', '**/*.mts', '**/*.mjs'],
    rules: {
      // Unused function arguments are common in framework callbacks; an
      // underscore prefix is the opt-out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
);
