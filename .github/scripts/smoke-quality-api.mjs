#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const mode = process.env.LANGPULSE_SMOKE_MODE ?? "public";
const config = JSON.parse(
  readFileSync(path.join(process.cwd(), "config", "metrics.json"), "utf8"),
);
const languageId =
  process.env.LANGPULSE_SMOKE_LANGUAGE_ID ?? config.languages.at(0)?.id;
const thresholdValue = Number.parseInt(
  process.env.LANGPULSE_SMOKE_THRESHOLD_VALUE ??
    `${config.thresholds.at(0)?.value ?? 0}`,
  10,
);

if (!languageId) {
  throw new Error("No language id available for smoke testing");
}

if (!Number.isInteger(thresholdValue) || thresholdValue < 0) {
  throw new Error(`Invalid threshold value: ${process.env.LANGPULSE_SMOKE_THRESHOLD_VALUE}`);
}

const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

switch (mode) {
  case "public":
    await runPublicSmoke(requiredEnv("LANGPULSE_SMOKE_BASE_URL"));
    break;
  case "lifecycle":
    await runLifecycleSmoke({
      baseUrl: requiredEnv("LANGPULSE_SMOKE_BASE_URL"),
      authToken: requiredEnv("LANGPULSE_SMOKE_INTERNAL_AUTH_TOKEN"),
      database: requiredEnv("LANGPULSE_SMOKE_D1_DATABASE"),
      wranglerConfig:
        process.env.LANGPULSE_SMOKE_WRANGLER_CONFIG ?? "worker/wrangler.toml",
      wranglerEnv:
        process.env.LANGPULSE_SMOKE_WRANGLER_ENV?.trim() || "smoke",
    });
    break;
  default:
    throw new Error(`Unsupported LANGPULSE_SMOKE_MODE: ${mode}`);
}

async function runPublicSmoke(publicBaseUrl) {
  await checkHealth(publicBaseUrl);

  const latestUrl = new URL("/api/quality/latest", ensureTrailingSlash(publicBaseUrl));
  const latest = await requestJsonOrText(latestUrl, {
    headers: { Accept: "application/json, text/plain;q=0.9" },
  });
  const observedDate = extractDate(latest.body);

  if (!observedDate) {
    throw new Error(
      `Unable to extract a published observed date from ${latestUrl}: ${JSON.stringify(latest.body)}`,
    );
  }

  const snapshotUrl = new URL("/api/quality/snapshot", ensureTrailingSlash(publicBaseUrl));
  snapshotUrl.searchParams.set("date", observedDate);
  snapshotUrl.searchParams.set("threshold", `${thresholdValue}`);

  const snapshot = await requestJsonOrText(snapshotUrl, {
    headers: { Accept: "application/json, text/plain;q=0.9" },
  });

  assertSnapshotSlice(snapshot.body, { observedDate, thresholdValue, languageId });
  console.log(
    `Public smoke check passed for ${languageId}@${thresholdValue} on ${observedDate} via ${publicBaseUrl}`,
  );
}

async function runLifecycleSmoke(options) {
  const observedDate =
    process.env.LANGPULSE_SMOKE_OBSERVED_DATE ?? new Date().toISOString().slice(0, 10);
  const activeLanguages = getActiveEntries(config.languages, observedDate);
  const activeThresholds = getActiveEntries(config.thresholds, observedDate);
  const expectedRows = activeLanguages.length * activeThresholds.length;

  if (expectedRows < 1) {
    throw new Error(`No active language-threshold pairs for observed date ${observedDate}`);
  }

  if (!activeLanguages.some((entry) => entry.id === languageId)) {
    throw new Error(
      `Configured smoke language ${languageId} is not active for observed date ${observedDate}`,
    );
  }

  if (!activeThresholds.some((entry) => entry.value === thresholdValue)) {
    throw new Error(
      `Configured smoke threshold ${thresholdValue} is not active for observed date ${observedDate}`,
    );
  }

  const authHeaderName =
    process.env.LANGPULSE_SMOKE_AUTH_HEADER_NAME ?? "Authorization";
  const authScheme = process.env.LANGPULSE_SMOKE_AUTH_SCHEME ?? "Bearer";
  const headers = {
    [authHeaderName]: authScheme
      ? `${authScheme} ${options.authToken}`.trim()
      : options.authToken,
    Accept: "application/json, text/plain;q=0.9",
    "Content-Type": "application/json",
  };

  const createTemplate =
    process.env.LANGPULSE_SMOKE_CREATE_BODY_JSON ??
    '{"observed_date":"{{OBSERVED_DATE}}","expected_rows":{{EXPECTED_ROWS}}}';
  const finalizeTemplate =
    process.env.LANGPULSE_SMOKE_FINALIZE_BODY_JSON ?? '{"status":"complete"}';

  const createUrl = new URL(
    process.env.LANGPULSE_SMOKE_CREATE_PATH ?? "/internal/quality-runs",
    ensureTrailingSlash(options.baseUrl),
  );

  if (shouldResetLifecycleState()) {
    // The dedicated smoke database is reused across deploys, so the current UTC
    // date must be cleared before re-running the publication lifecycle contract.
    await resetObservedDate(options, observedDate);
  }

  const firstRun = await createRun(createUrl, headers, createTemplate, observedDate);
  await expireLease(options, firstRun.runId);

  const secondRun = await createRun(createUrl, headers, createTemplate, observedDate);
  if (secondRun.runId === firstRun.runId) {
    throw new Error("Retry run reused the expired run_id");
  }
  if (secondRun.attemptNo <= firstRun.attemptNo) {
    throw new Error(
      `Retry attempt number did not increase: first=${firstRun.attemptNo}, second=${secondRun.attemptNo}`,
    );
  }

  // Single batch write replaces the prior per-row PUT loop: the worker now
  // only exposes POST /internal/quality-runs/:id/rows:batch, so the smoke
  // script must aggregate every language x threshold pair into one payload.
  const collectedAt = new Date().toISOString();
  const batchRows = activeLanguages.flatMap((activeLanguage, index) =>
    activeThresholds.map((activeThreshold, thresholdIndex) => ({
      language_id: activeLanguage.id,
      threshold_value: activeThreshold.value,
      count: 123 + index + thresholdIndex,
      collected_at: collectedAt,
    })),
  );

  const batchUrl = fillUrlTemplate(
    process.env.LANGPULSE_SMOKE_ROWS_BATCH_PATH_TEMPLATE ??
      "/internal/quality-runs/{{RUN_ID}}/rows:batch",
    ensureTrailingSlash(options.baseUrl),
    { RUN_ID: secondRun.runId },
  );
  const batchResponse = await requestJsonOrText(batchUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ rows: batchRows }),
  });

  // The batch endpoint returns qualityRunResponse(run); surface a mismatch
  // early so a regression on the response contract fails the smoke suite.
  const batchRunId = extractString(batchResponse.body, ["run_id", "runId", "id"]);
  if (batchRunId && batchRunId !== secondRun.runId) {
    throw new Error(
      `Batch row upsert response run_id ${batchRunId} did not match request run_id ${secondRun.runId}`,
    );
  }

  const finalizeUrl = fillUrlTemplate(
    process.env.LANGPULSE_SMOKE_FINALIZE_PATH_TEMPLATE ??
      "/internal/quality-runs/{{RUN_ID}}/finalize",
    ensureTrailingSlash(options.baseUrl),
    { RUN_ID: secondRun.runId },
  );
  await requestJsonOrText(finalizeUrl, {
    method: "POST",
    headers,
    body: fillTemplate(finalizeTemplate, {
      RUN_ID: secondRun.runId,
      OBSERVED_DATE: observedDate,
    }),
  });

  await checkHealth(options.baseUrl);

  const latestUrl = new URL("/api/quality/latest", ensureTrailingSlash(options.baseUrl));
  const latest = await requestJsonOrText(latestUrl, {
    headers: { Accept: "application/json, text/plain;q=0.9" },
  });
  const publishedDate = extractDate(latest.body);
  if (publishedDate !== observedDate) {
    throw new Error(
      `Expected smoke publication date ${observedDate}, received ${publishedDate ?? "none"}`,
    );
  }

  const snapshotUrl = new URL("/api/quality/snapshot", ensureTrailingSlash(options.baseUrl));
  snapshotUrl.searchParams.set("date", observedDate);
  snapshotUrl.searchParams.set("threshold", `${thresholdValue}`);
  const snapshot = await requestJsonOrText(snapshotUrl, {
    headers: { Accept: "application/json, text/plain;q=0.9" },
  });
  assertSnapshotSlice(snapshot.body, { observedDate, thresholdValue, languageId });

  const rejectStatuses = parseStatusSet(
    process.env.LANGPULSE_SMOKE_REJECT_STATUSES ?? "409,422",
  );
  const rejection = await requestJsonOrText(createUrl, {
    method: "POST",
    headers,
    body: fillTemplate(createTemplate, {
      OBSERVED_DATE: observedDate,
      EXPECTED_ROWS: `${expectedRows}`,
    }),
    expectStatus: rejectStatuses,
  });

  if (!rejectStatuses.has(rejection.status)) {
    throw new Error(
      `Expected publication-immutability rejection with status ${[...rejectStatuses].join(", ")}, received ${rejection.status}`,
    );
  }

  console.log(
    `Lifecycle smoke check passed for ${observedDate} via ${options.baseUrl}`,
  );
}

async function checkHealth(baseUrl) {
  const healthUrl = new URL(
    process.env.LANGPULSE_SMOKE_HEALTH_PATH ?? "/api/health",
    ensureTrailingSlash(baseUrl),
  );
  await requestJsonOrText(healthUrl, {
    headers: { Accept: "application/json, text/plain;q=0.9" },
  });
}

async function createRun(url, headers, template, observedDate) {
  const activeLanguages = getActiveEntries(config.languages, observedDate);
  const activeThresholds = getActiveEntries(config.thresholds, observedDate);
  const expectedRows = activeLanguages.length * activeThresholds.length;
  const response = await requestJsonOrText(url, {
    method: "POST",
    headers,
    body: fillTemplate(template, {
      OBSERVED_DATE: observedDate,
      EXPECTED_ROWS: `${expectedRows}`,
    }),
  });

  const runId = extractString(response.body, ["run_id", "runId", "id"]);
  const attemptNo = extractNumber(response.body, [
    "attempt_no",
    "attemptNo",
    "attempt",
  ]);

  if (!runId) {
    throw new Error(`Unable to extract run_id from create response: ${JSON.stringify(response.body)}`);
  }

  if (!Number.isInteger(attemptNo) || attemptNo < 1) {
    throw new Error(
      `Unable to extract attempt number from create response: ${JSON.stringify(response.body)}`,
    );
  }

  return { runId, attemptNo };
}

async function expireLease(options, runId) {
  const sql = [
    "UPDATE quality_30d_runs",
    "SET lease_expires_at = '2000-01-01T00:00:00Z',",
    "    last_heartbeat_at = '2000-01-01T00:00:00Z'",
    `WHERE run_id = '${runId.replaceAll("'", "''")}';`,
  ].join(" ");

  const args = [
    "d1",
    "execute",
    options.database,
    "--remote",
    "--config",
    options.wranglerConfig,
    "--env",
    options.wranglerEnv,
    "--command",
    sql,
  ];

  await spawnCommand("wrangler", args);
}

async function resetObservedDate(options, observedDate) {
  const quotedObservedDate = observedDate.replaceAll("'", "''");
  // D1's HTTP API rejects explicit BEGIN TRANSACTION/COMMIT/SAVEPOINT (error
  // code 7500) — it manages transactions itself. The deletes are ordered so
  // the run_rows cleanup resolves its run_id subquery before the parent
  // quality_30d_runs row is removed; each statement runs independently, which
  // is acceptable for smoke reset since a partial failure just causes the
  // next smoke run to surface the leftover state.
  const sql = [
    `DELETE FROM quality_30d_publications WHERE observed_date = '${quotedObservedDate}';`,
    "DELETE FROM quality_30d_run_rows",
    "WHERE run_id IN (",
    "  SELECT run_id",
    "  FROM quality_30d_runs",
    `  WHERE observed_date = '${quotedObservedDate}'`,
    ");",
    `DELETE FROM quality_30d_runs WHERE observed_date = '${quotedObservedDate}';`,
  ].join(" ");

  const args = [
    "d1",
    "execute",
    options.database,
    "--remote",
    "--config",
    options.wranglerConfig,
    "--env",
    options.wranglerEnv,
    "--command",
    sql,
  ];

  await spawnCommand("wrangler", args);
}

function fillUrlTemplate(template, baseUrl, values) {
  return new URL(fillTemplate(template, values), baseUrl);
}

function fillTemplate(template, values) {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

function getActiveEntries(entries, observedDate) {
  if (!UTC_DATE_PATTERN.test(observedDate)) {
    throw new Error(`Invalid observed date for smoke lifecycle: ${observedDate}`);
  }

  return entries.filter((entry) => {
    const activeFrom = entry.active_from;
    const activeTo = entry.active_to;
    return activeFrom <= observedDate && (activeTo === null || observedDate <= activeTo);
  });
}

async function requestJsonOrText(url, options) {
  const expectStatus = options.expectStatus ?? new Set([200, 201, 202, 204]);
  const response = await fetch(url, options);
  const bodyText = await response.text();

  if (!expectStatus.has(response.status)) {
    throw new Error(
      `HTTP ${response.status} from ${url}: ${bodyText || "<empty body>"}`,
    );
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

function assertSnapshotSlice(body, { observedDate, thresholdValue, languageId }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`Expected snapshot body object, received: ${JSON.stringify(body)}`);
  }
  if (body.observed_date !== observedDate) {
    throw new Error(
      `Expected snapshot observed_date ${observedDate}, received ${body.observed_date ?? "none"}`,
    );
  }
  if (body.threshold !== thresholdValue) {
    throw new Error(
      `Expected snapshot threshold ${thresholdValue}, received ${body.threshold ?? "none"}`,
    );
  }
  if (!Array.isArray(body.languages) || body.languages.length === 0) {
    throw new Error(`Expected non-empty languages array in snapshot: ${JSON.stringify(body)}`);
  }
  const entry = body.languages.find((language) => language?.id === languageId);
  if (!entry) {
    throw new Error(
      `Expected language ${languageId} in snapshot languages: ${JSON.stringify(body.languages)}`,
    );
  }
  if (!Number.isInteger(entry.count) || entry.count < 0) {
    throw new Error(
      `Expected non-negative integer count for ${languageId}, received ${JSON.stringify(entry)}`,
    );
  }
}

function extractDate(value) {
  if (typeof value === "string") {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractDate(item);
      if (extracted) {
        return extracted;
      }
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const key of [
      "observed_date",
      "observedDate",
      "latest_observed_date",
      "latestObservedDate",
      "date",
      "latest",
    ]) {
      const candidate = value[key];
      if (typeof candidate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
        return candidate;
      }
    }

    for (const nested of Object.values(value)) {
      const extracted = extractDate(nested);
      if (extracted) {
        return extracted;
      }
    }
  }

  return null;
}

function extractString(value, keys) {
  return extractByKeys(value, keys, (candidate) =>
    typeof candidate === "string" && candidate.length > 0 ? candidate : null,
  );
}

function extractNumber(value, keys) {
  return extractByKeys(value, keys, (candidate) => {
    if (Number.isInteger(candidate)) {
      return candidate;
    }

    if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
      return Number.parseInt(candidate, 10);
    }

    return null;
  });
}

function extractByKeys(value, keys, projector) {
  if (!value || typeof value !== "object") {
    return null;
  }

  for (const key of keys) {
    const projected = projector(value[key]);
    if (projected != null) {
      return projected;
    }
  }

  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") {
      const extracted = extractByKeys(nested, keys, projector);
      if (extracted != null) {
        return extracted;
      }
    }
  }

  return null;
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function shouldResetLifecycleState() {
  const configuredValue = process.env.LANGPULSE_SMOKE_RESET_BEFORE_LIFECYCLE?.trim();
  if (!configuredValue) {
    return true;
  }

  return !["0", "false", "no"].includes(configuredValue.toLowerCase());
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseStatusSet(value) {
  return new Set(
    value
      .split(",")
      .map((entry) => Number.parseInt(entry.trim(), 10))
      .filter((entry) => Number.isInteger(entry)),
  );
}

function spawnCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by signal ${signal}`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }

      resolve();
    });
  });
}
