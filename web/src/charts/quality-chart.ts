import type { QualitySeriesPoint } from "../api";

export interface QualityChartModel {
  languageLabel: string;
  points: QualitySeriesPoint[];
}

interface ThresholdSeries {
  thresholdValue: number;
  label: string;
  points: Array<{ observedDate: string; observedAt: string; count: number }>;
  color: string;
}

const CHART_COLORS = ["#ff6b35", "#005f73", "#9b2226", "#3a86ff", "#6a994e"];
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const VIEWBOX_WIDTH = 760;
const VIEWBOX_HEIGHT = 360;
const PADDING_TOP = 28;
const PADDING_RIGHT = 24;
const PADDING_BOTTOM = 52;
const PADDING_LEFT = 64;
const Y_TICK_COUNT = 4;

type XScale = (index: number) => number;
type YScale = (value: number) => number;

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tagName: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NAMESPACE, tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }

  return element;
}

function collectThresholds(points: QualitySeriesPoint[]): ThresholdSeries[] {
  const seriesByThreshold = new Map<number, ThresholdSeries>();

  for (const point of points) {
    for (const threshold of point.thresholds) {
      const existingSeries = seriesByThreshold.get(threshold.threshold_value);
      const currentSeries =
        existingSeries ??
        {
          thresholdValue: threshold.threshold_value,
          label: `>= ${threshold.threshold_value} stars`,
          points: [],
          color: CHART_COLORS[seriesByThreshold.size % CHART_COLORS.length],
        };

      currentSeries.points.push({
        observedDate: point.observed_date,
        observedAt: point.observed_at,
        count: threshold.count,
      });

      if (existingSeries === undefined) {
        seriesByThreshold.set(threshold.threshold_value, currentSeries);
      }
    }
  }

  return Array.from(seriesByThreshold.values()).sort(
    (left, right) => left.thresholdValue - right.thresholdValue,
  );
}

function roundUpMax(value: number): number {
  if (value <= 0) {
    return 1;
  }

  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function createPath(segments: string[][]): string {
  return segments
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.join(" "))
    .join(" ");
}

function createGridGroup(boundedMaxCount: number, yScale: YScale): SVGGElement {
  const grid = createSvgElement("g", { class: "quality-chart__grid" });
  for (let tickIndex = 0; tickIndex <= Y_TICK_COUNT; tickIndex += 1) {
    const tickValue = boundedMaxCount / Y_TICK_COUNT * tickIndex;
    const y = yScale(tickValue);
    grid.appendChild(
      createSvgElement("line", {
        x1: String(PADDING_LEFT),
        y1: String(y),
        x2: String(VIEWBOX_WIDTH - PADDING_RIGHT),
        y2: String(y),
      }),
    );

    const tickLabel = createSvgElement("text", {
      x: String(PADDING_LEFT - 12),
      y: String(y + 4),
      "text-anchor": "end",
      class: "quality-chart__axis-text",
    });
    tickLabel.textContent = String(Math.round(tickValue));
    grid.appendChild(tickLabel);
  }

  return grid;
}

function createXAxisGroup(
  observedDates: string[],
  plotHeight: number,
  xScale: XScale,
): SVGGElement {
  const xAxis = createSvgElement("g", { class: "quality-chart__axis" });
  const xLabelIndexes = Array.from(
    new Set([0, Math.floor((observedDates.length - 1) / 2), observedDates.length - 1]),
  ).filter((index) => index >= 0);

  for (const index of xLabelIndexes) {
    const x = xScale(index);
    xAxis.appendChild(
      createSvgElement("line", {
        x1: String(x),
        y1: String(PADDING_TOP),
        x2: String(x),
        y2: String(PADDING_TOP + plotHeight),
      }),
    );

    const label = createSvgElement("text", {
      x: String(x),
      y: String(PADDING_TOP + plotHeight + 24),
      "text-anchor": "middle",
      class: "quality-chart__axis-text",
    });
    label.textContent = observedDates[index];
    xAxis.appendChild(label);
  }

  return xAxis;
}

function buildSeriesPathSegments(
  series: ThresholdSeries,
  observedDates: string[],
  xScale: XScale,
  yScale: YScale,
): string[][] {
  const pointsByDate = new Map(series.points.map((point) => [point.observedDate, point]));
  const pathSegments: string[][] = [];
  let currentSegment: string[] = [];

  for (const [index, observedDate] of observedDates.entries()) {
    const point = pointsByDate.get(observedDate);
    if (point === undefined) {
      if (currentSegment.length > 0) {
        pathSegments.push(currentSegment);
        currentSegment = [];
      }
      continue;
    }

    const x = xScale(index);
    const y = yScale(point.count);
    currentSegment.push(`${currentSegment.length === 0 ? "M" : "L"} ${x} ${y}`);
  }

  if (currentSegment.length > 0) {
    pathSegments.push(currentSegment);
  }

  return pathSegments;
}

function createLegendItem(series: ThresholdSeries): HTMLLIElement {
  const legendItem = document.createElement("li");
  legendItem.className = "quality-chart__legend-item";

  const swatch = document.createElement("span");
  swatch.className = "quality-chart__swatch";
  swatch.style.setProperty("--swatch", series.color);

  legendItem.append(swatch, series.label);
  return legendItem;
}

function createSeriesPath(series: ThresholdSeries, pathSegments: string[][]): SVGPathElement {
  return createSvgElement("path", {
    d: createPath(pathSegments),
    class: "quality-chart__line",
    stroke: series.color,
  });
}

function createSeriesMarkers(
  series: ThresholdSeries,
  observedDateIndexes: Map<string, number>,
  xScale: XScale,
  yScale: YScale,
): SVGCircleElement[] {
  const markers: SVGCircleElement[] = [];
  for (const point of series.points) {
    const index = observedDateIndexes.get(point.observedDate);
    if (index === undefined) {
      continue;
    }

    const circle = createSvgElement("circle", {
      cx: String(xScale(index)),
      cy: String(yScale(point.count)),
      r: "4",
      fill: series.color,
    });
    const title = createSvgElement("title", {});
    title.textContent = `${series.label} on ${point.observedDate}: ${point.count} repositories observed at ${point.observedAt}`;
    circle.appendChild(title);
    markers.push(circle);
  }

  return markers;
}

export function renderQualityChart(container: HTMLElement, model: QualityChartModel): void {
  if (model.points.length === 0) {
    container.replaceChildren();
    return;
  }

  const thresholdSeries = collectThresholds(model.points);
  const observedDates = model.points.map((point) => point.observed_date);
  const maxCount = Math.max(
    ...thresholdSeries.flatMap((series) => series.points.map((point) => point.count)),
    0,
  );
  const boundedMaxCount = roundUpMax(maxCount);
  const plotWidth = VIEWBOX_WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const plotHeight = VIEWBOX_HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const xDenominator = Math.max(observedDates.length - 1, 1);
  const yScale = (value: number): number =>
    PADDING_TOP + plotHeight - value / boundedMaxCount * plotHeight;
  const xScale = (index: number): number => PADDING_LEFT + index / xDenominator * plotWidth;

  const chart = document.createElement("figure");
  chart.className = "quality-chart";

  const legend = document.createElement("ul");
  legend.className = "quality-chart__legend";

  const svg = createSvgElement("svg", {
    viewBox: `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`,
    class: "quality-chart__svg",
    role: "img",
    "aria-label": `${model.languageLabel} repository quality chart`,
  });
  const observedDateIndexes = new Map(observedDates.map((observedDate, index) => [observedDate, index]));
  svg.append(
    createGridGroup(boundedMaxCount, yScale),
    createXAxisGroup(observedDates, plotHeight, xScale),
  );

  for (const series of thresholdSeries) {
    const pathSegments = buildSeriesPathSegments(series, observedDates, xScale, yScale);
    legend.appendChild(createLegendItem(series));
    svg.appendChild(createSeriesPath(series, pathSegments));
    svg.append(...createSeriesMarkers(series, observedDateIndexes, xScale, yScale));
  }

  chart.append(svg, legend);
  container.replaceChildren(chart);
}
