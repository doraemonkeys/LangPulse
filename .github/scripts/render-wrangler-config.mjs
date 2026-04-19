#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RUN_LEASE_DURATION_SECONDS = "300";
const DEFAULT_DATABASE_BINDING = "DB";
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

// Cloudflare bindings (vars, d1, unsafe.*) are non-inheritable: anything
// declared at the top level is ignored when wrangler deploys with --env=NAME.
// The rate limiter therefore has to be re-emitted under each env scope or
// /api/health will throw at runtime against an undefined binding.
const HEALTH_RATE_LIMITER_NAME = "HEALTH_RATE_LIMITER";
const HEALTH_RATE_LIMITER_NAMESPACE_ID = "1001";
const HEALTH_RATE_LIMITER_LIMIT = 30;
const HEALTH_RATE_LIMITER_PERIOD_SECONDS = 60;

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
    // Only migration-applying callers need this; other callers (deploy, d1
    // execute, smoke tests) omit it so wrangler skips migration resolution.
    migrationsDir: source.LANGPULSE_MIGRATIONS_DIR?.trim() || undefined,
  };
}

export function renderWranglerConfig(options) {
  validateEnvironmentName(options.environmentName);

  // The rendered config is CI-only: strip the dev-only top-level [vars] block
  // so wrangler doesn't warn "vars.INTERNAL_API_TOKEN exists at the top level,
  // but not on env.NAME.vars" (top-level vars aren't inherited to envs). The
  // deploy workflow pushes INTERNAL_API_TOKEN as a Worker secret, and
  // RUN_LEASE_DURATION_SECONDS is re-emitted per env below.
  const template = stripTopLevelVarsBlock(
    readFileSync(options.templatePath, "utf8"),
  ).trimEnd();

  // `migrations_dir` is a field of each [[d1_databases]] entry — wrangler
  // rejects it at the top level and ignores it outside the D1 binding. CI
  // passes an absolute path; the rendered config itself lives next to the
  // template inside worker/ so wrangler's other relative paths (main,
  // assets.directory) also resolve correctly.
  const d1DatabaseBlock = [
    `[[env.${options.environmentName}.d1_databases]]`,
    `binding = ${quoteTomlString(options.databaseBinding)}`,
    `database_name = ${quoteTomlString(options.databaseName)}`,
    `database_id = ${quoteTomlString(options.databaseId)}`,
  ];
  if (options.migrationsDir) {
    d1DatabaseBlock.push(
      `migrations_dir = ${quoteTomlString(options.migrationsDir)}`,
    );
  }

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
    ...d1DatabaseBlock,
    "",
    `[[env.${options.environmentName}.unsafe.bindings]]`,
    `name = ${quoteTomlString(HEALTH_RATE_LIMITER_NAME)}`,
    `type = "ratelimit"`,
    `namespace_id = ${quoteTomlString(HEALTH_RATE_LIMITER_NAMESPACE_ID)}`,
    `simple = { limit = ${HEALTH_RATE_LIMITER_LIMIT}, period = ${HEALTH_RATE_LIMITER_PERIOD_SECONDS} }`,
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

function stripTopLevelVarsBlock(body) {
  const lines = body.split("\n");
  const out = [];
  let insideVars = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!insideVars && trimmed === "[vars]") {
      insideVars = true;
      continue;
    }
    if (insideVars && trimmed.startsWith("[")) {
      insideVars = false;
    }
    if (!insideVars) {
      out.push(line);
    }
  }
  return out.join("\n");
}
