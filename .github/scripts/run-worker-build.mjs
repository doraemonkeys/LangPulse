#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveRenderOptions,
  writeRenderedWranglerConfig,
} from "./render-wrangler-config.mjs";

const DEFAULT_WRANGLER_CONFIG = "wrangler.toml";
const WORKER_DIRECTORY = process.cwd();
const WEB_ASSET_ENTRYPOINT = path.resolve(WORKER_DIRECTORY, "../web/dist/index.html");

const tempDirectory = mkdtempSync(
  path.join(os.tmpdir(), "langpulse-worker-build-"),
);

try {
  assertWebAssetsBuilt();
  const { configPath } = resolveWranglerConfig(process.env, tempDirectory);
  await runDryRunBuild(configPath, process.env.LANGPULSE_WRANGLER_ENV?.trim());
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}

function assertWebAssetsBuilt() {
  if (existsSync(WEB_ASSET_ENTRYPOINT)) {
    return;
  }

  throw new Error(
    `Missing built web assets at ${WEB_ASSET_ENTRYPOINT}. Build web/dist before dry-running the Worker deployment.`,
  );
}

function resolveWranglerConfig(source, temporaryDirectory) {
  const explicitConfigPath = source.LANGPULSE_WRANGLER_CONFIG?.trim();
  if (explicitConfigPath) {
    return {
      configPath: path.resolve(WORKER_DIRECTORY, explicitConfigPath),
    };
  }

  if (hasRenderContract(source)) {
    const outputPath = path.join(
      temporaryDirectory,
      `${source.LANGPULSE_WRANGLER_ENV.trim()}.wrangler.toml`,
    );

    return {
      configPath: writeRenderedWranglerConfig({
        ...resolveRenderOptions({
          ...source,
          LANGPULSE_WRANGLER_OUTPUT: outputPath,
        }),
        outputPath,
      }),
    };
  }

  const fallbackConfigPath = path.resolve(WORKER_DIRECTORY, DEFAULT_WRANGLER_CONFIG);
  if (!existsSync(fallbackConfigPath)) {
    throw new Error(`Missing Wrangler config at ${fallbackConfigPath}`);
  }

  return {
    configPath: fallbackConfigPath,
  };
}

function hasRenderContract(source) {
  return [
    "LANGPULSE_WRANGLER_TEMPLATE",
    "LANGPULSE_WRANGLER_ENV",
    "LANGPULSE_D1_DATABASE_NAME",
    "LANGPULSE_D1_DATABASE_ID",
  ].every((name) => source[name]?.trim());
}

function runDryRunBuild(configPath, environmentName) {
  const command = [
    "wrangler",
    "deploy",
    "--dry-run",
    "--config",
    configPath,
  ];

  if (environmentName) {
    command.push("--env", environmentName);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: WORKER_DIRECTORY,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Worker dry-run terminated by signal ${signal}`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Worker dry-run failed with exit code ${code}`));
        return;
      }

      resolve();
    });
  });
}
