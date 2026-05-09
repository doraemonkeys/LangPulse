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

// Wrangler 4.x on Windows can leak its esbuild service child after the deploy
// command logically completes; the orphan keeps wrangler's node process alive
// because its stdio pipes never close, and `make ci` then hangs at the
// dry-run step indefinitely. We detect the final log line wrangler prints
// before exiting ("--dry-run: exiting now.") and, if the process hasn't
// reaped within a short grace, force-kill the whole subtree. The bug does
// not manifest on POSIX shells, where the same code path is a no-op because
// the process exits naturally before the grace timer fires.
const COMPLETION_SENTINEL = "--dry-run: exiting now.";
const POST_SENTINEL_GRACE_MS = 8000;

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
      // Pipe stdout/stderr (instead of inherit) so we can scan for the
      // completion sentinel without losing live console streaming.
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
      shell: process.platform === "win32",
    });

    let sentinelSeen = false;
    let forceKilled = false;
    let graceTimer = null;

    const watchForSentinel = (source, sink) => {
      source.on("data", (chunk) => {
        sink.write(chunk);
        if (sentinelSeen) return;
        if (chunk.toString().includes(COMPLETION_SENTINEL)) {
          sentinelSeen = true;
          graceTimer = setTimeout(() => {
            forceKilled = true;
            killProcessTree(child);
          }, POST_SENTINEL_GRACE_MS);
        }
      });
    };

    watchForSentinel(child.stdout, process.stdout);
    watchForSentinel(child.stderr, process.stderr);

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
      }
      // If wrangler printed the sentinel but only died because we reaped its
      // stuck process tree, the build itself succeeded — wrangler finished
      // its work, it just could not tear down its esbuild service child.
      if (forceKilled && sentinelSeen) {
        resolve();
        return;
      }
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

function killProcessTree(child) {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    // taskkill /T walks descendants — necessary because the wrangler shim
    // runs through cmd.exe and spawns the esbuild service as a grandchild,
    // which child.kill() alone would not signal.
    spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
    });
    return;
  }
  child.kill("SIGKILL");
}
