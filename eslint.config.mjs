// The structural floor (macula-io/macula-codebase-checks#9): deep nesting and
// tangled functions fail the build. No baseline, no inline disables.
import tsParser from "@typescript-eslint/parser";

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
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: floor,
  },
];
