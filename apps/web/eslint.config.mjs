import angular from 'angular-eslint';
import tseslint from 'typescript-eslint';
import base from '../../eslint.config.base.mjs';

export default tseslint.config(
  ...base,
  {
    files: ['**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      // The SSR entry point logs its listening port on boot.
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.html'],
    // Accessibility rules matter more here than in the admin — this is the
    // surface real learners use.
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
  },
);
