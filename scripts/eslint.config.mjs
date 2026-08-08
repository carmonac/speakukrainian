import base from '../eslint.config.base.mjs';

export default [
  ...base,
  {
    files: ['**/*.ts'],
    rules: {
      // A CLI script reports its result on stdout; that is its whole output.
      'no-console': 'off',
    },
  },
  {
    files: ['types/*.d.ts'],
    rules: {
      /**
       * An ambient `declare module` block cannot carry a top-level import —
       * that would turn the file into a module and the block into an
       * augmentation of a module that has no declarations to augment. An
       * inline `import('node:stream').Readable` is the only way to name a type
       * from inside one.
       */
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
];
