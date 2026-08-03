import base from '../../eslint.config.base.mjs';

export default [
  ...base,
  {
    files: ['**/*.ts'],
    rules: {
      /**
       * OFF, and it must stay off.
       *
       * NestJS resolves constructor injection from the parameter types that
       * `emitDecoratorMetadata` writes into the compiled output. A `type`
       * import is erased before that metadata is emitted, so autofixing
       * `import { Reflector }` to `import { type Reflector }` produces code
       * that compiles cleanly and then fails to resolve the dependency at
       * runtime — exactly the kind of break tests do not catch.
       */
      '@typescript-eslint/consistent-type-imports': 'off',

      // Constructors that exist only to declare injected parameters are the
      // normal shape of a Nest provider.
      '@typescript-eslint/no-useless-constructor': 'off',

      // The bootstrap logger legitimately writes to stdout.
      'no-console': 'off',
    },
  },
];
