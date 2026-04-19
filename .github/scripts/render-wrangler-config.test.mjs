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
    // The rendered config is CI-only; the dev-only top-level [vars] block
    // (INTERNAL_API_TOKEN sentinel + RUN_LEASE_DURATION_SECONDS) must be
    // stripped so wrangler does not warn about top-level vars not being
    // inherited to env.NAME.vars. INTERNAL_API_TOKEN is pushed as a Worker
    // secret at deploy time; RUN_LEASE_DURATION_SECONDS is re-emitted per env.
    assert.equal(rendered.includes("INTERNAL_API_TOKEN"), false);
    assert.doesNotMatch(rendered, /^\[vars\]$/m);
  });

  it("emits migrations_dir inside the env-scoped [[d1_databases]] block when provided", () => {
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

    // Wrangler rejects top-level migrations_dir with an "Unexpected fields"
    // warning and ignores it outside [[d1_databases]]; the field must live
    // inside the env-scoped D1 binding to actually drive migration resolution.
    const d1BlockStart = rendered.indexOf(
      "[[env.production.d1_databases]]",
    );
    assert.notEqual(d1BlockStart, -1, "rendered output must contain env-scoped d1 block");

    const nextSectionMatch = rendered
      .slice(d1BlockStart + "[[env.production.d1_databases]]".length)
      .match(/^\[/m);
    const d1BlockEnd =
      nextSectionMatch === null
        ? rendered.length
        : d1BlockStart +
          "[[env.production.d1_databases]]".length +
          nextSectionMatch.index;
    const d1Block = rendered.slice(d1BlockStart, d1BlockEnd);
    assert.match(d1Block, /migrations_dir = "\/workspace\/migrations"/);
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
    // Mirrors renderWranglerConfig: the rendered config must strip the
    // dev-only top-level [vars] block so wrangler doesn't emit the
    // "vars not inherited to envs" warning about INTERNAL_API_TOKEN.
    assert.equal(contents.includes("INTERNAL_API_TOKEN"), false);
    assert.doesNotMatch(contents, /^\[vars\]$/m);
  });
});
