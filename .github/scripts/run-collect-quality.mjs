#!/usr/bin/env node

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const REQUIRED_ENV = ["COLLECTOR_COMMAND", "LANGPULSE_API_BASE_URL"];

for (const name of REQUIRED_ENV) {
  if (!process.env[name]?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const collectorCommand = process.env.COLLECTOR_COMMAND.trim();
const retryBudget = parsePositiveInteger(
  process.env.COLLECTOR_RETRY_BUDGET,
  "COLLECTOR_RETRY_BUDGET",
  3,
);
const retryDelaySeconds = parsePositiveInteger(
  process.env.COLLECTOR_RETRY_DELAY_SECONDS,
  "COLLECTOR_RETRY_DELAY_SECONDS",
  300,
);
const latestUrl = new URL(
  process.env.LANGPULSE_LATEST_PATH ?? "/api/quality/latest",
  ensureTrailingSlash(process.env.LANGPULSE_API_BASE_URL.trim()),
);
const expectedObservedDate =
  process.env.LANGPULSE_EXPECTED_OBSERVED_DATE ?? currentUtcDate();

let lastObservedDate = null;

for (let attempt = 1; attempt <= retryBudget; attempt += 1) {
  console.log(
    `Collector attempt ${attempt}/${retryBudget} for observed date ${expectedObservedDate}`,
  );

  const exitCode = await runCommand(collectorCommand);
  console.log(`Collector process exited with code ${exitCode}`);

  try {
    const latestPayload = await fetchJsonOrText(latestUrl);
    lastObservedDate = extractObservedDate(latestPayload.body);
    console.log(
      `Latest published observed date after attempt ${attempt}: ${lastObservedDate ?? "none"}`,
    );
  } catch (error) {
    console.error(`Failed to query latest publication: ${formatError(error)}`);
  }

  if (lastObservedDate === expectedObservedDate) {
    console.log(`Publication confirmed for ${expectedObservedDate}`);
    process.exit(0);
  }

  if (attempt < retryBudget) {
    console.log(
      `Publication not visible yet. Waiting ${retryDelaySeconds}s before retry.`,
    );
    await sleep(retryDelaySeconds * 1000);
  }
}

throw new Error(
  `No publication for ${expectedObservedDate} after ${retryBudget} automated collector attempt(s). Last published date: ${lastObservedDate ?? "none"}`,
);

function parsePositiveInteger(value, envName, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer. Received: ${value}`);
  }

  return parsed;
}

function currentUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Collector terminated by signal ${signal}`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}

async function fetchJsonOrText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json, text/plain;q=0.9",
    },
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${bodyText}`);
  }

  return {
    status: response.status,
    body: parseBody(bodyText),
  };
}

function parseBody(bodyText) {
  if (!bodyText.trim()) {
    return null;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText.trim();
  }
}

function extractObservedDate(payload) {
  if (payload == null) {
    return null;
  }

  if (typeof payload === "string") {
    return isDateString(payload) ? payload : null;
  }

  if (Array.isArray(payload)) {
    for (const value of payload) {
      const extracted = extractObservedDate(value);
      if (extracted) {
        return extracted;
      }
    }

    return null;
  }

  if (typeof payload === "object") {
    const dateKeys = [
      "observed_date",
      "observedDate",
      "latest_observed_date",
      "latestObservedDate",
      "date",
      "latest",
    ];

    for (const key of dateKeys) {
      const value = payload[key];
      if (typeof value === "string" && isDateString(value)) {
        return value;
      }
    }

    for (const value of Object.values(payload)) {
      const extracted = extractObservedDate(value);
      if (extracted) {
        return extracted;
      }
    }
  }

  return null;
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
