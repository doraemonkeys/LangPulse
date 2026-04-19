import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  renderWranglerConfig,
  resolveRenderOptions,
  writeRenderedWranglerConfig,
} from "./render-wrangler-config.mjs";

const TEMPLATE_FIXTURE = [
  'name = "langpulse-worker"',
  'main = "src/index.ts"',
  "",
  "[vars]",
  'INTERNAL_API_TOKEN = "test-internal-token"',
  'RUN_LEASE_DURATION_SECONDS = "300"',
  "",
].join("\n");

function makeSource(overrides = {}) {
  return {
    LANGPULSE_WRANGLER_TEMPLATE: "ignored-in-resolver-tests",
    LANGPULSE_WRANGLER_OUTPUT: "ignored-in-resolver-tests",
    LANGPULSE_WRANGLER_ENV: "production",
    LANGPULSE_D1_DATABASE_NAME: "langpulse",
    LANGPULSE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000",
    ...overrides,
  };
}

describe("resolveRenderOptions", () => {
  it("defaults lease seconds and database binding when overrides are missing", () => {
    const options = resolveRenderOptions(makeSource());
    assert.equal(options.runLeaseDurationSeconds, "300");
    assert.equal(options.databaseBinding, "DB");
    assert.equal(Object.prototype.hasOwnProperty.call(options, "internalApiToken"), false);
  });

  it("honors explicit lease-duration and binding overrides", () => {
    const options = resolveRenderOptions(
      makeSource({
        LANGPULSE_RUN_LEASE_DURATION_SECONDS: "120",
        LANGPULSE_D1_BINDING: "PRIMARY",
      }),
    );
    assert.equal(options.runLeaseDurationSeconds, "120");
    assert.equal(options.databaseBinding, "PRIMARY");
  });

  it("throws when required envs are missing", () => {
    for (const key of [
      "LANGPULSE_WRANGLER_TEMPLATE",
      "LANGPULSE_WRANGLER_OUTPUT",
      "LANGPULSE_WRANGLER_ENV",
      "LANGPULSE_D1_DATABASE_NAME",
      "LANGPULSE_D1_DATABASE_ID",
    ]) {
      const source = makeSource();
      delete source[key];
      assert.throws(() => resolveRenderOptions(source), new RegExp(key));
    }
  });

  it("does not require LANGPULSE_INTERNAL_API_TOKEN", () => {
    assert.doesNotThrow(() => resolveRenderOptions(makeSource()));
  });

  it("leaves migrationsDir undefined when LANGPULSE_MIGRATIONS_DIR is absent", () => {
    const options = resolveRenderOptions(makeSource());
    assert.equal(options.migrationsDir, undefined);
  });

  it("honors LANGPULSE_MIGRATIONS_DIR when provided", () => {
    const options = resolveRenderOptions(
      makeSource({ LANGPULSE_MIGRATIONS_DIR: "/workspace/migrations" }),
    );
    assert.equal(options.migrationsDir, "/workspace/migrations");
  });
});

describe("renderWranglerConfig", () => {
  let workdir;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(tmpdir(), "langpulse-render-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("emits env-scoped lease duration and D1 binding without the internal token", () => {
    const templatePath = path.join(workdir, "wrangler.toml");
    writeFileSync(templatePath, TEMPLATE_FIXTURE);

    const rendered = renderWranglerConfig({
      templatePath,
      outputPath: path.join(workdir, "out.toml"),
      environmentName: "production",
      databaseName: "langpulse",
      databaseId: "00000000-0000-0000-0000-000000000000",
      runLeaseDurationSeconds: "600",
      databaseBinding: "DB",
    });

    assert.match(rendered, /\[env\.production\.vars\]/);
    assert.match(rendered, /RUN_LEASE_DURATION_SECONDS = "600"/);
    assert.match(rendered, /\[\[env\.production\.d1_databases\]\]/);
    assert.match(rendered, /binding = "DB"/);
    assert.match(rendered, /database_id = "00000000-0000-0000-0000-000000000000"/);
    // Cloudflare bindings are non-inheritable across envs, so the rate limiter
    // for /api/health must be re-emitted under [[env.NAME.unsafe.bindings]].
    assert.match(rendered, /\[\[env\.production\.unsafe\.bindings\]\]/);
    assert.match(rendered, /name = "HEALTH_RATE_LIMITER"/);
    assert.match(rendered, /type = "ratelimit"/);
    assert.match(rendered, /simple = \{ limit = 30, period = 60 \}/);
    // Regression guard: the plaintext INTERNAL_API_TOKEN binding must never
    // reappear in the appended env-scoped block — the deploy workflow pushes
    // it as a Worker secret instead. The dev-only `[vars]` sentinel in the
    // template body is preserved verbatim for Vitest/wrangler-dev.
    const appended = rendered.slice(TEMPLATE_FIXTURE.trimEnd().length);
    assert.equal(appended.includes("INTERNAL_API_TOKEN"), false);
  });

  it("emits top-level migrations_dir before any [section] when provided", () => {
    const templatePath = path.join(workdir, "wrangler.toml");
    writeFileSync(templatePath, TEMPLATE_FIXTURE);

    const rendered = renderWranglerConfig({
      templatePath,
      outputPath: path.join(workdir, "out.toml"),
      environmentName: "production",
      databaseName: "langpulse",
      databaseId: "00000000-0000-0000-0000-000000000000",
      runLeaseDurationSeconds: "300",
      databaseBinding: "DB",
      migrationsDir: "/workspace/migrations",
    });

    const migrationsDirIndex = rendered.indexOf(
      'migrations_dir = "/workspace/migrations"',
    );
    assert.notEqual(
      migrationsDirIndex,
      -1,
      "rendered output must contain migrations_dir",
    );

    // Any `[section]` appearing before migrations_dir would make TOML parse it
    // as a scoped key — guard against that regression explicitly.
    const firstSectionMatch = rendered.match(/^\[[^\n]*$/m);
    assert.ok(firstSectionMatch, "rendered output must contain at least one section");
    const firstSectionIndex = rendered.indexOf(firstSectionMatch[0]);
    assert.ok(
      migrationsDirIndex < firstSectionIndex,
      "migrations_dir must be emitted before any [section] header",
    );
  });

  it("omits migrations_dir when not provided", () => {
    const templatePath = path.join(workdir, "wrangler.toml");
    writeFileSync(templatePath, TEMPLATE_FIXTURE);

    const rendered = renderWranglerConfig({
      templatePath,
      outputPath: path.join(workdir, "out.toml"),
      environmentName: "production",
      databaseName: "langpulse",
      databaseId: "00000000-0000-0000-0000-000000000000",
      runLeaseDurationSeconds: "300",
      databaseBinding: "DB",
    });

    assert.equal(rendered.includes("migrations_dir"), false);
  });

  it("rejects environment names that contain shell-unsafe characters", () => {
    const templatePath = path.join(workdir, "wrangler.toml");
    writeFileSync(templatePath, TEMPLATE_FIXTURE);

    assert.throws(
      () =>
        renderWranglerConfig({
          templatePath,
          outputPath: path.join(workdir, "out.toml"),
          environmentName: "pro duction",
          databaseName: "langpulse",
          databaseId: "id",
          runLeaseDurationSeconds: "300",
          databaseBinding: "DB",
        }),
      /letters, digits/,
    );
  });
});

describe("writeRenderedWranglerConfig", () => {
  let workdir;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(tmpdir(), "langpulse-write-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("creates parent directories and writes the config", () => {
    const templatePath = path.join(workdir, "wrangler.toml");
    writeFileSync(templatePath, TEMPLATE_FIXTURE);
    const outputPath = path.join(workdir, "nested", "out.toml");

    const writtenPath = writeRenderedWranglerConfig({
      templatePath,
      outputPath,
      environmentName: "smoke",
      databaseName: "langpulse-smoke",
      databaseId: "id-smoke",
      runLeaseDurationSeconds: "300",
      databaseBinding: "DB",
    });

    assert.equal(writtenPath, outputPath);
    const contents = readFileSync(outputPath, "utf8");
    assert.match(contents, /\[env\.smoke\.vars\]/);
    // Same regression guard as renderWranglerConfig: appended env block must
    // not carry INTERNAL_API_TOKEN; the template sentinel is left intact.
    const appended = contents.slice(TEMPLATE_FIXTURE.trimEnd().length);
    assert.equal(appended.includes("INTERNAL_API_TOKEN"), false);
  });
});
