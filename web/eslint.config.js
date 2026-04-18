import js from "@eslint/js";
import globals from "globals";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

const DEFAULT_COGNITIVE_COMPLEXITY = 14;
const DEFAULT_FUNCTION_LINES = 140;
const ENTRYPOINT_FUNCTION_LINES = 190;
const TEST_FUNCTION_LINES = 240;
const TEST_GLOBALS = {
  afterEach: "readonly",
  beforeEach: "readonly",
  describe: "readonly",
  expect: "readonly",
  it: "readonly",
  vi: "readonly",
};

export default defineConfig([
  globalIgnores(["dist", "coverage"]),
  {
    files: ["eslint.config.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    files: ["vite.config.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { sonarjs },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "max-lines-per-function": [
        "error",
        {
          max: DEFAULT_FUNCTION_LINES,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
      "sonarjs/cognitive-complexity": ["error", DEFAULT_COGNITIVE_COMPLEXITY],
    },
  },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { sonarjs },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.browser,
    },
    rules: {
      "max-lines-per-function": [
        "error",
        {
          max: DEFAULT_FUNCTION_LINES,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
      "sonarjs/cognitive-complexity": ["error", DEFAULT_COGNITIVE_COMPLEXITY],
    },
  },
  {
    files: ["src/main.ts", "src/charts/quality-chart.ts"],
    rules: {
      "max-lines-per-function": [
        "error",
        {
          max: ENTRYPOINT_FUNCTION_LINES,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
      // The dashboard entrypoint and chart renderer legitimately combine DOM
      // orchestration with presentation rules, so they get a scoped budget.
      "sonarjs/cognitive-complexity": ["error", 18],
    },
  },
  {
    files: ["src/**/*.test.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...TEST_GLOBALS,
      },
    },
    rules: {
      "max-lines-per-function": [
        "error",
        {
          max: TEST_FUNCTION_LINES,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
      "sonarjs/cognitive-complexity": ["error", 20],
    },
  },
]);
