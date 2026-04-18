#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const [, , targetDirArg, action, ...rest] = process.argv;

if (!targetDirArg || !action) {
  throw new Error(
    "Usage: node .github/scripts/run-workspace-command.mjs <dir> <install|script> [script-name ...args]",
  );
}

const repoRoot = process.cwd();
const targetDir = path.resolve(repoRoot, targetDirArg);
const targetPackageJson = path.join(targetDir, "package.json");

if (!existsSync(targetPackageJson)) {
  throw new Error(`Expected package.json at ${targetPackageJson}`);
}

const workspace = resolveWorkspace(targetDir, repoRoot);

switch (action) {
  case "install":
    await run(workspace.installCommand, workspace.rootDir);
    break;
  case "script":
    if (rest.length === 0) {
      throw new Error("Missing package script name");
    }

    await run(workspace.scriptCommand(rest), targetDir);
    break;
  default:
    throw new Error(`Unsupported action: ${action}`);
}

function resolveWorkspace(startDir, stopDir) {
  let cursor = startDir;
  let chosenRoot = null;
  let manager = null;

  while (isWithin(cursor, stopDir)) {
    const detected = detectPackageManager(cursor);
    if (detected) {
      chosenRoot = cursor;
      manager = detected;
      break;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }

    cursor = parent;
  }

  if (!manager) {
    chosenRoot = startDir;
    manager =
      detectPackageManagerFromPackageJson(path.join(startDir, "package.json")) ?? "npm";
  }

  return {
    rootDir: chosenRoot,
    installCommand: installCommand(manager),
    scriptCommand: (args) => scriptCommand(manager, args),
  };
}

function detectPackageManager(directory) {
  if (existsSync(path.join(directory, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (existsSync(path.join(directory, "package-lock.json"))) {
    return "npm";
  }

  if (existsSync(path.join(directory, "yarn.lock"))) {
    return "yarn";
  }

  if (
    existsSync(path.join(directory, "bun.lock")) ||
    existsSync(path.join(directory, "bun.lockb"))
  ) {
    return "bun";
  }

  return detectPackageManagerFromPackageJson(path.join(directory, "package.json"));
}

function detectPackageManagerFromPackageJson(packageJsonPath) {
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (typeof packageJson.packageManager === "string") {
    if (packageJson.packageManager.startsWith("pnpm@")) {
      return "pnpm";
    }

    if (packageJson.packageManager.startsWith("npm@")) {
      return "npm";
    }

    if (packageJson.packageManager.startsWith("yarn@")) {
      return "yarn";
    }

    if (packageJson.packageManager.startsWith("bun@")) {
      return "bun";
    }
  }

  return null;
}

function installCommand(manager) {
  switch (manager) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "npm":
      return "npm ci";
    case "yarn":
      return "yarn install --frozen-lockfile";
    case "bun":
      return "bun install --frozen-lockfile";
    default:
      throw new Error(`Unsupported package manager: ${manager}`);
  }
}

function scriptCommand(manager, args) {
  const escapedArgs = args.map(shellEscape).join(" ");

  switch (manager) {
    case "pnpm":
      return `pnpm run ${escapedArgs}`;
    case "npm":
      return `npm run ${escapedArgs}`;
    case "yarn":
      return `yarn run ${escapedArgs}`;
    case "bun":
      return `bun run ${escapedArgs}`;
    default:
      throw new Error(`Unsupported package manager: ${manager}`);
  }
}

function shellEscape(value) {
  if (/^[A-Za-z0-9._:/=-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function run(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
      cwd,
      env: process.env,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Command terminated by signal ${signal}`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code}: ${command}`));
        return;
      }

      resolve();
    });
  });
}
