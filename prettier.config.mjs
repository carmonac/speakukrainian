{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "semi": true,
  "overrides": [
    {
      "files": "apps/{admin,web}/src/**/*.html",
      "options": {
        "// parser": "The angular parser understands @if / @for control flow; the html parser flattens their indentation.",
        "parser": "angular",
        "printWidth": 120
      }
    }
  ]
}
