/**
 * A JS config rather than `.prettierrc.json` so the override below can carry a
 * real comment: Prettier rejects `"// key"` pseudo-comments and warns about the
 * ignored option once per file it formats.
 *
 * @type {import('prettier').Config}
 */
export default {
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  semi: true,
  overrides: [
    {
      files: 'apps/{admin,web}/src/**/*.html',
      options: {
        // The angular parser understands @if / @for control flow; the html
        // parser flattens their indentation.
        parser: 'angular',
        printWidth: 120,
      },
    },
  ],
};
