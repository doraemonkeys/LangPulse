import { describe, expect, it } from "vitest";
import {
  buildChartViewModel,
  FOCUSED_DOMAIN_PADDING_RATIO,
  MIN_VISIBLE_DOMAIN_PCT,
  RAW_FIELD_SUFFIX,
  RELATIVE_DOMAIN_PADDING_PCT,
  RELATIVE_FIELD_SUFFIX,
} from "./series";
import type { CompareResponse } from "../api/types";

function compare(
  languages: string[],
  series: Array<{ date: string; counts: Record<string, number | null | undefined> }>,
): CompareResponse {
  return {
    threshold: 2,
    from: series[0]?.date ?? "",
    to: series[series.length - 1]?.date ?? "",
    languages: languages.map((id) => ({ id, label: id })),
    series: series.map((point) => {
      const counts: Record<string, number> = {};
      for (const id of languages) {
        const value = point.counts[id];
        if (value !== undefined && value !== null) counts[id] = value;
      }
      return { observed_date: point.date, counts };
    }),
  };
}

describe("buildChartViewModel — absolute mode", () => {
  it("zero-anchors the Y domain when languages have mixed magnitudes", () => {
    const data = compare(
      ["python", "brainfuck"],
      [
        { date: "2026-04-01", counts: { python: 5000, brainfuck: 50 } },
        { date: "2026-04-02", counts: { python: 5100, brainfuck: 51 } },
      ],
    );
    const vm = buildChartViewModel(data, "absolute");
    expect(vm.yDomain[0]).toBe(0);
    expect(vm.yDomain[1]).toBeGreaterThan(5100);
  });

  it("focuses the Y domain when two languages share a similar magnitude", () => {
    const data = compare(
      ["go", "java"],
      [
        { date: "2026-04-01", counts: { go: 1000, java: 1100 } },
        { date: "2026-04-02", counts: { go: 1020, java: 1120 } },
      ],
    );
    const vm = buildChartViewModel(data, "absolute");
    expect(vm.yDomain[0]).toBeGreaterThan(0);
    expect(vm.yDomain[0]).toBeLessThan(1000);
    expect(vm.yDomain[1]).toBeGreaterThan(1120);
    const padding = Math.max((1120 - 1000) * FOCUSED_DOMAIN_PADDING_RATIO, 1);
    expect(vm.yDomain[0]).toBeCloseTo(1000 - padding, 5);
    expect(vm.yDomain[1]).toBeCloseTo(1120 + padding, 5);
  });

  it("uses a focused min/max+padding domain for a single-language series", () => {
    const data = compare(
      ["go"],
      [
        { date: "2026-04-01", counts: { go: 1000 } },
        { date: "2026-04-02", counts: { go: 1020 } },
      ],
    );
    const vm = buildChartViewModel(data, "absolute");
    expect(vm.yDomain[0]).toBeGreaterThan(0);
    expect(vm.yDomain[0]).toBeLessThan(1000);
    expect(vm.yDomain[1]).toBeGreaterThan(1020);
    const padding = Math.max((1020 - 1000) * FOCUSED_DOMAIN_PADDING_RATIO, 1);
    expect(vm.yDomain[0]).toBeCloseTo(1000 - padding, 5);
    expect(vm.yDomain[1]).toBeCloseTo(1020 + padding, 5);
  });

  it("attaches both raw and relative sidecar fields to every row", () => {
    const data = compare(
      ["go"],
      [
        { date: "2026-04-01", counts: { go: 100 } },
        { date: "2026-04-02", counts: { go: 102 } },
      ],
    );
    const vm = buildChartViewModel(data, "absolute");
    expect(vm.rows[0][`go${RAW_FIELD_SUFFIX}`]).toBe(100);
    expect(vm.rows[0][`go${RELATIVE_FIELD_SUFFIX}`]).toBe(0);
    expect(vm.rows[1][`go${RELATIVE_FIELD_SUFFIX}`]).toBeCloseTo(2, 5);
  });

  it("plots the raw count as the displayed value", () => {
    const data = compare(
      ["go"],
      [{ date: "2026-04-01", counts: { go: 100 } }],
    );
    const vm = buildChartViewModel(data, "absolute");
    expect(vm.rows[0].go).toBe(100);
  });

  it("emits null for missing counts and never coerces them to zero", () => {
    const data = compare(
      ["go", "rust"],
      [
        { date: "2026-04-01", counts: { go: 10, rust: 5 } },
        { date: "2026-04-02", counts: { go: 12 } },
      ],
    );
    const vm = buildChartViewModel(data, "absolute");
    expect(vm.rows[1].rust).toBeNull();
    expect(vm.rows[1][`rust${RAW_FIELD_SUFFIX}`]).toBeNull();
    expect(vm.rows[1][`rust${RELATIVE_FIELD_SUFFIX}`]).toBeNull();
  });

  it("survives empty series and empty language lists", () => {
    const empty = compare([], []);
    const vm = buildChartViewModel(empty, "absolute");
    expect(vm.rows).toEqual([]);
    expect(vm.yDomain[0]).toBeLessThanOrEqual(vm.yDomain[1]);
  });
});

describe("buildChartViewModel — relative mode", () => {
  it("rebases each language to its own first non-zero count and emits 0% at the baseline", () => {
    const data = compare(
      ["go"],
      [
        { date: "2026-04-01", counts: { go: 200 } },
        { date: "2026-04-02", counts: { go: 220 } },
        { date: "2026-04-03", counts: { go: 210 } },
      ],
    );
    const vm = buildChartViewModel(data, "relative");
    expect(vm.rows[0].go).toBe(0);
    expect(vm.rows[1].go).toBeCloseTo(10, 5);
    expect(vm.rows[2].go).toBeCloseTo(5, 5);
    expect(vm.baselineByLanguage.get("go")).toBe(200);
  });

  it("uses the first valid sample as the baseline when the first day is missing", () => {
    const data = compare(
      ["go"],
      [
        { date: "2026-04-01", counts: {} },
        { date: "2026-04-02", counts: { go: 500 } },
        { date: "2026-04-03", counts: { go: 525 } },
      ],
    );
    const vm = buildChartViewModel(data, "relative");
    expect(vm.rows[0].go).toBeNull();
    expect(vm.rows[1].go).toBe(0);
    expect(vm.rows[2].go).toBeCloseTo(5, 5);
  });

  it("flags zero-only series as unavailable instead of dividing by zero", () => {
    const data = compare(
      ["nascent"],
      [
        { date: "2026-04-01", counts: { nascent: 0 } },
        { date: "2026-04-02", counts: { nascent: 0 } },
      ],
    );
    const vm = buildChartViewModel(data, "relative");
    expect(vm.unavailableByLanguage.get("nascent")).toBe("zero_baseline");
    expect(vm.rows.every((row) => row.nascent === null)).toBe(true);
  });

  it("flags fully-missing series as unavailable", () => {
    const data = compare(
      ["ghost"],
      [
        { date: "2026-04-01", counts: {} },
        { date: "2026-04-02", counts: {} },
      ],
    );
    const vm = buildChartViewModel(data, "relative");
    expect(vm.unavailableByLanguage.get("ghost")).toBe("no_data");
  });

  it("expands the Y domain to a visible band when every relative value collapses to 0%", () => {
    const data = compare(
      ["go"],
      [{ date: "2026-04-01", counts: { go: 100 } }],
    );
    const vm = buildChartViewModel(data, "relative");
    expect(vm.yDomain[1]).toBeGreaterThanOrEqual(MIN_VISIBLE_DOMAIN_PCT);
    expect(vm.yDomain[0]).toBeLessThanOrEqual(-MIN_VISIBLE_DOMAIN_PCT);
  });

  it("keeps 0% inside the Y domain even when all values are positive", () => {
    const data = compare(
      ["go"],
      [
        { date: "2026-04-01", counts: { go: 100 } },
        { date: "2026-04-02", counts: { go: 110 } },
        { date: "2026-04-03", counts: { go: 120 } },
      ],
    );
    const vm = buildChartViewModel(data, "relative");
    expect(vm.yDomain[0]).toBeLessThanOrEqual(0);
    expect(vm.yDomain[1]).toBeGreaterThanOrEqual(20 + RELATIVE_DOMAIN_PADDING_PCT - 0.001);
  });

  it("does not connect points before the baseline date", () => {
    const data = compare(
      ["go"],
      [
        { date: "2026-04-01", counts: {} },
        { date: "2026-04-02", counts: { go: 100 } },
        { date: "2026-04-03", counts: { go: 110 } },
      ],
    );
    const vm = buildChartViewModel(data, "relative");
    expect(vm.rows[0].go).toBeNull();
    expect(vm.rows[1].go).toBe(0);
    expect(vm.rows[2].go).toBeCloseTo(10, 5);
  });
});
