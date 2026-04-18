import js from "@eslint/js";
import globals from "globals";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

const DEFAULT_COGNITIVE_COMPLEXITY = 16;
const DEFAULT_FUNCTION_LINES = 160;
const ORCHESTRATION_COGNITIVE_COMPLEXITY = 24;
const ORCHESTRATION_FUNCTION_LINES = 240;
const TEST_COGNITIVE_COMPLEXITY = 22;
const TEST_FUNCTION_LINES = 280;
const TEST_GLOBALS = {
  afterAll: "readonly",
  afterEach: "readonly",
  beforeAll: "readonly",
  beforeEach: "readonly",
  describe: "readonly",
  expect: "readonly",
  it: "readonly",
  vi: "readonly",
};

export default defineConfig([
  globalIgnores(["coverage"]),
  {
    files: ["eslint.config.js", "vitest.config.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { sonarjs },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.serviceworker,
      },
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
    files: ["src/quality-runs.ts"],
    rules: {
      "max-lines-per-function": [
        "error",
        {
          max: ORCHESTRATION_FUNCTION_LINES,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
      // This module still owns the run state machine end-to-end, so the
      // temporary budget is scoped here instead of loosening all worker code.
      "sonarjs/cognitive-complexity": ["error", ORCHESTRATION_COGNITIVE_COMPLEXITY],
    },
  },
  {
    files: ["test/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { sonarjs },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.serviceworker,
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
      "sonarjs/cognitive-complexity": ["error", TEST_COGNITIVE_COMPLEXITY],
    },
  },
  {
    files: ["test/logic-coverage.test.ts"],
    rules: {
      "max-lines-per-function": [
        "error",
        {
          max: 620,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
    },
  },
]);
