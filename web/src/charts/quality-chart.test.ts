import { describe, expect, it } from "vitest";

import { renderQualityChart } from "./quality-chart";

describe("renderQualityChart", () => {
  it("renders cumulative threshold series and point tooltips", () => {
    const container = document.createElement("div");

    renderQualityChart(container, {
      languageLabel: "Go",
      points: [
        {
          observed_date: "2026-04-01",
          observed_at: "2026-04-01T01:00:00.000Z",
          published_at: "2026-04-01T01:05:00.000Z",
          thresholds: [
            { threshold_value: 0, count: 20 },
            { threshold_value: 10, count: 12 },
          ],
        },
        {
          observed_date: "2026-04-02",
          observed_at: "2026-04-02T01:00:00.000Z",
          published_at: "2026-04-02T01:05:00.000Z",
          thresholds: [
            { threshold_value: 0, count: 26 },
            { threshold_value: 10, count: 15 },
          ],
        },
      ],
    });

    expect(container.querySelectorAll("path.quality-chart__line")).toHaveLength(2);
    expect(container.textContent).toContain(">= 0 stars");
    expect(container.textContent).toContain(">= 10 stars");
    expect(container.querySelector("circle title")?.textContent).toContain(
      "observed at 2026-04-01T01:00:00.000Z",
    );
  });

  it("clears the chart host when there are no points", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>stale</p>";

    renderQualityChart(container, {
      languageLabel: "Go",
      points: [],
    });

    expect(container.innerHTML).toBe("");
  });

  it("keeps rendering when counts are zero or a later snapshot omits a retired threshold", () => {
    const container = document.createElement("div");

    renderQualityChart(container, {
      languageLabel: "Ruby",
      points: [
        {
          observed_date: "2026-04-01",
          observed_at: "2026-04-01T01:00:00.000Z",
          published_at: "2026-04-01T01:05:00.000Z",
          thresholds: [
            { threshold_value: 0, count: 0 },
            { threshold_value: 50, count: 0 },
          ],
        },
        {
          observed_date: "2026-04-02",
          observed_at: "2026-04-02T01:00:00.000Z",
          published_at: "2026-04-02T01:05:00.000Z",
          thresholds: [{ threshold_value: 0, count: 3 }],
        },
      ],
    });

    expect(container.querySelectorAll("path.quality-chart__line")).toHaveLength(2);
    expect(container.textContent).toContain(">= 50 stars");
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toContain("Ruby");
  });
});
