#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RUN_LEASE_DURATION_SECONDS = "300";
const DEFAULT_DATABASE_BINDING = "DB";
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

if (isCliEntryPoint(import.meta.url)) {
  writeRenderedWranglerConfig(resolveRenderOptions(process.env));
}

export function resolveRenderOptions(source) {
  return {
    templatePath: requiredEnv("LANGPULSE_WRANGLER_TEMPLATE", source),
    outputPath: requiredEnv("LANGPULSE_WRANGLER_OUTPUT", source),
    environmentName: requiredEnv("LANGPULSE_WRANGLER_ENV", source),
    databaseName: requiredEnv("LANGPULSE_D1_DATABASE_NAME", source),
    databaseId: requiredEnv("LANGPULSE_D1_DATABASE_ID", source),
    runLeaseDurationSeconds:
      source.LANGPULSE_RUN_LEASE_DURATION_SECONDS?.trim() ||
      DEFAULT_RUN_LEASE_DURATION_SECONDS,
    databaseBinding:
      source.LANGPULSE_D1_BINDING?.trim() || DEFAULT_DATABASE_BINDING,
  };
}

export function renderWranglerConfig(options) {
  validateEnvironmentName(options.environmentName);

  const template = readFileSync(options.templatePath, "utf8").trimEnd();
  // INTERNAL_API_TOKEN is pushed as a Worker secret by the deploy workflow
  // (cloudflare/wrangler-action@v3 `secrets:` input) so it never appears as a
  // plaintext `[vars]` entry in the deployed configuration.
  return [
    template,
    "",
    `# CI appends deploy-time bindings so each environment resolves the worker`,
    `# lease duration and D1 database from the same configuration.`,
    `[env.${options.environmentName}.vars]`,
    `RUN_LEASE_DURATION_SECONDS = ${quoteTomlString(options.runLeaseDurationSeconds)}`,
    "",
    `[[env.${options.environmentName}.d1_databases]]`,
    `binding = ${quoteTomlString(options.databaseBinding)}`,
    `database_name = ${quoteTomlString(options.databaseName)}`,
    `database_id = ${quoteTomlString(options.databaseId)}`,
    "",
  ].join("\n");
}

export function writeRenderedWranglerConfig(options) {
  const renderedConfig = renderWranglerConfig(options);
  mkdirSync(path.dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, renderedConfig, "utf8");
  return options.outputPath;
}

function requiredEnv(name, source) {
  const value = source[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function validateEnvironmentName(environmentName) {
  if (!ENVIRONMENT_NAME_PATTERN.test(environmentName)) {
    throw new Error(
      `LANGPULSE_WRANGLER_ENV must contain only letters, digits, "_" or "-": ${environmentName}`,
    );
  }
}

function isCliEntryPoint(moduleUrl) {
  if (!process.argv[1]) {
    return false;
  }

  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(moduleUrl));
}

function quoteTomlString(value) {
  return JSON.stringify(value);
}
