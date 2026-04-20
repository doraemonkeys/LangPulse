import js from "@eslint/js";
import globals from "globals";
import sonarjs from "eslint-plugin-sonarjs";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

const DEFAULT_COGNITIVE_COMPLEXITY = 14;
const DEFAULT_FUNCTION_LINES = 140;
const COMPONENT_FUNCTION_LINES = 220;
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
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { sonarjs, "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      "max-lines-per-function": [
        "error",
        {
          max: COMPONENT_FUNCTION_LINES,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
      "sonarjs/cognitive-complexity": ["error", DEFAULT_COGNITIVE_COMPLEXITY],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["src/**/*.test.{ts,tsx}"],
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
