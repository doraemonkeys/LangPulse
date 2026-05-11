import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { runCollectorUntilPublication } from "./collect-quality-publication.mjs";

function makeEnv(overrides = {}) {
  return {
    COLLECTOR_COMMAND: "./collector",
    COLLECTOR_PUBLICATION_POLL_ATTEMPTS: "3",
    COLLECTOR_PUBLICATION_POLL_DELAY_SECONDS: "300",
    LANGPULSE_API_BASE_URL: "https://langpulse.example",
    LANGPULSE_EXPECTED_OBSERVED_DATE: "2026-05-07",
    ...overrides,
  };
}

function makeLogger() {
  const messages = [];
  return {
    messages,
    log(message) {
      messages.push(message);
    },
    error(message) {
      messages.push(message);
    },
  };
}

describe("runCollectorUntilPublication", () => {
  it("fails fast when the collector exits nonzero and the publication is stale", async () => {
    let commandCalls = 0;
    const sleeps = [];
    const logger = makeLogger();

    await assert.rejects(
      () =>
        runCollectorUntilPublication(makeEnv(), {
          logger,
          runCommand: async () => {
            commandCalls += 1;
            return 1;
          },
          fetchJsonOrText: async () => ({
            body: { observed_date: "2026-05-06" },
          }),
          sleep: async (durationMs) => {
            sleeps.push(durationMs);
          },
        }),
      /Collector failed with exit code 1/,
    );

    assert.equal(commandCalls, 1);
    assert.deepEqual(sleeps, []);
    assert.match(
      logger.messages.join("\n"),
      /Latest published observed date after collector run: 2026-05-06/,
    );
  });

  it("polls latest without rerunning the collector after a successful run", async () => {
    let commandCalls = 0;
    const sleeps = [];
    const responses = [
      { body: { observed_date: "2026-05-06" } },
      { body: { latestObservedDate: "2026-05-07" } },
    ];

    await runCollectorUntilPublication(makeEnv(), {
      logger: makeLogger(),
      runCommand: async () => {
        commandCalls += 1;
        return 0;
      },
      fetchJsonOrText: async (url) => {
        assert.equal(String(url), "https://langpulse.example/api/quality/latest");
        return responses.shift();
      },
      sleep: async (durationMs) => {
        sleeps.push(durationMs);
      },
    });

    assert.equal(commandCalls, 1);
    assert.deepEqual(sleeps, [300_000]);
    assert.equal(responses.length, 0);
  });

  it("accepts an already-visible publication even when a duplicate collector run exits nonzero", async () => {
    let commandCalls = 0;
    const sleeps = [];

    await runCollectorUntilPublication(makeEnv(), {
      logger: makeLogger(),
      runCommand: async () => {
        commandCalls += 1;
        return 1;
      },
      fetchJsonOrText: async () => ({
        body: { observed_date: "2026-05-07" },
      }),
      sleep: async (durationMs) => {
        sleeps.push(durationMs);
      },
    });

    assert.equal(commandCalls, 1);
    assert.deepEqual(sleeps, []);
  });
});
