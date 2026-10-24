// The structural floor (macula-io/macula-codebase-checks#9): deep nesting and
// tangled functions fail the build. No baseline, no inline disables.
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const floor = {
  "max-depth": ["error", 3],
  "complexity": ["error", 9],
};

export default [
  { ignores: ["dist/", "node_modules/", "out/"] },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: floor,
  },
  {
    // Type-aware, production source only (tsconfig.json excludes **/*.test.ts, so the project service
    // cannot see the tests). One rule: callers of an API that turns async must be made to await it. A
    // promise nobody handles is not a style question -- Node exits the whole MCP server on the rejection
    // (macula-mcp#44 step 7 review: the credential stores went async and one caller was left behind).
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: { "@typescript-eslint/no-floating-promises": "error" },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: floor,
  },
];
