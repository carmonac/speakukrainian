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
];
