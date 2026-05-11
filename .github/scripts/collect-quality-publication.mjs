import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { extractObservedDate, parseBody } from "./quality-latest-payload.mjs";

export async function runCollectorUntilPublication(source, dependencies = {}) {
  const settings = resolveSettings(source);
  const executeCommand = dependencies.runCommand ?? runCommand;
  const fetchLatest = dependencies.fetchJsonOrText ?? fetchJsonOrText;
  const wait = dependencies.sleep ?? sleep;
  const logger = dependencies.logger ?? console;

  logInfo(logger, `Collector run for observed date ${settings.expectedObservedDate}`);

  const exitCode = await executeCommand(settings.collectorCommand);
  logInfo(logger, `Collector process exited with code ${exitCode}`);

  let lastObservedDate = null;
  const firstLatest = await readLatestObservedDate(
    settings.latestUrl,
    fetchLatest,
    logger,
    "collector run",
  );
  if (firstLatest.queried) {
    lastObservedDate = firstLatest.observedDate;
  }

  if (lastObservedDate === settings.expectedObservedDate) {
    logInfo(logger, `Publication confirmed for ${settings.expectedObservedDate}`);
    return;
  }

  if (exitCode !== 0) {
    throw new Error(
      `Collector failed with exit code ${exitCode}; publication for ${settings.expectedObservedDate} is not confirmed. Last published date: ${lastObservedDate ?? "none"}`,
    );
  }

  for (let pollAttempt = 2; pollAttempt <= settings.publicationPollAttempts; pollAttempt += 1) {
    logInfo(
      logger,
      `Publication not visible yet. Waiting ${settings.publicationPollDelaySeconds}s before polling latest again.`,
    );
    await wait(settings.publicationPollDelaySeconds * 1000);

    const latest = await readLatestObservedDate(
      settings.latestUrl,
      fetchLatest,
      logger,
      `publication poll ${pollAttempt}/${settings.publicationPollAttempts}`,
    );
    if (latest.queried) {
      lastObservedDate = latest.observedDate;
    }

    if (lastObservedDate === settings.expectedObservedDate) {
      logInfo(logger, `Publication confirmed for ${settings.expectedObservedDate}`);
      return;
    }
  }

  throw new Error(
    `No publication for ${settings.expectedObservedDate} after ${settings.publicationPollAttempts} publication check(s). Last published date: ${lastObservedDate ?? "none"}`,
  );
}

export function resolveSettings(source) {
  const collectorCommand = requiredEnv("COLLECTOR_COMMAND", source);
  const apiBaseUrl = requiredEnv("LANGPULSE_API_BASE_URL", source);

  return {
    collectorCommand,
    publicationPollAttempts: parsePositiveInteger(
      source.COLLECTOR_PUBLICATION_POLL_ATTEMPTS,
      "COLLECTOR_PUBLICATION_POLL_ATTEMPTS",
      3,
    ),
    publicationPollDelaySeconds: parsePositiveInteger(
      source.COLLECTOR_PUBLICATION_POLL_DELAY_SECONDS,
      "COLLECTOR_PUBLICATION_POLL_DELAY_SECONDS",
      300,
    ),
    latestUrl: new URL(
      source.LANGPULSE_LATEST_PATH ?? "/api/quality/latest",
      ensureTrailingSlash(apiBaseUrl),
    ),
    expectedObservedDate: source.LANGPULSE_EXPECTED_OBSERVED_DATE ?? currentUtcDate(),
  };
}

function requiredEnv(name, source) {
  const value = source[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function readLatestObservedDate(url, fetchLatest, logger, label) {
  try {
    const latestPayload = await fetchLatest(url);
    const observedDate = extractObservedDate(latestPayload.body);
    logInfo(
      logger,
      `Latest published observed date after ${label}: ${observedDate ?? "none"}`,
    );
    return { queried: true, observedDate };
  } catch (error) {
    logError(logger, `Failed to query latest publication: ${formatError(error)}`);
    return { queried: false, observedDate: null };
  }
}

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

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function logInfo(logger, message) {
  logger.log(message);
}

function logError(logger, message) {
  if (typeof logger.error === "function") {
    logger.error(message);
    return;
  }

  logger.log(message);
}
