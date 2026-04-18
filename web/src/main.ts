import "./style.css";

import type { MetadataResponse, PublicLanguage, QualityApi, QualityResponse } from "./api";
import { ApiError, createQualityApi } from "./api";
import { renderQualityChart } from "./charts/quality-chart";

const DEFAULT_RANGE_DAYS = 90;
const STATE_CLASS_LOADING = "app-shell--loading";
const STATE_CLASS_ERROR = "app-shell--error";
const STATE_CLASS_EMPTY = "app-shell--empty";

interface DashboardElements {
  shell: HTMLElement;
  form: HTMLFormElement;
  languageSelect: HTMLSelectElement;
  fromInput: HTMLInputElement;
  toInput: HTMLInputElement;
  message: HTMLElement;
  summary: HTMLElement;
  metadata: HTMLElement;
  chart: HTMLElement;
  table: HTMLElement;
}

function addDays(date: string, delta: number): string {
  const utcDate = new Date(`${date}T00:00:00.000Z`);
  utcDate.setUTCDate(utcDate.getUTCDate() + delta);
  return utcDate.toISOString().slice(0, 10);
}

function compareDates(left: string, right: string): number {
  return left.localeCompare(right);
}

export function computeDefaultRange(
  launchDate: string,
  latestObservedDate: string | null,
  windowDays = DEFAULT_RANGE_DAYS,
): { from: string; to: string } {
  if (latestObservedDate === null) {
    return { from: launchDate, to: launchDate };
  }

  const candidateFrom = addDays(latestObservedDate, -(windowDays - 1));
  return {
    from: compareDates(candidateFrom, launchDate) < 0 ? launchDate : candidateFrom,
    to: latestObservedDate,
  };
}

export function partitionLanguages(languages: PublicLanguage[]): {
  active: PublicLanguage[];
  retired: PublicLanguage[];
} {
  return languages.reduce(
    (groups, language) => {
      if (language.active_to === null) {
        groups.active.push(language);
      } else {
        groups.retired.push(language);
      }

      return groups;
    },
    {
      active: [] as PublicLanguage[],
      retired: [] as PublicLanguage[],
    },
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "An unexpected error occurred.";
}

function createTemplate(): string {
  return `
    <main class="app-shell ${STATE_CLASS_LOADING}">
      <section class="hero">
        <p class="hero__eyebrow">Launch-forward quality snapshot</p>
        <h1>Repositories pushed in the last 30 days</h1>
        <p class="hero__lede">
          One public dataset, observed in UTC, showing how many repositories remain active after crossing each star threshold.
        </p>
      </section>

      <section class="controls-card">
        <form class="controls" aria-label="Quality filters">
          <label class="control">
            <span>Language</span>
            <select name="language"></select>
          </label>
          <label class="control">
            <span>From</span>
            <input name="from" type="date" required />
          </label>
          <label class="control">
            <span>To</span>
            <input name="to" type="date" required />
          </label>
          <button type="submit">Update range</button>
        </form>
        <div class="metadata-note" data-metadata></div>
      </section>

      <section class="content-card">
        <div class="section-heading">
          <div>
            <h2>Published snapshots</h2>
            <p data-summary>Loading published snapshots…</p>
          </div>
          <div class="message" data-message aria-live="polite"></div>
        </div>
        <div class="chart-host" data-chart></div>
        <div class="snapshot-table" data-table></div>
      </section>
    </main>
  `;
}

function bindElements(root: HTMLElement): DashboardElements {
  root.innerHTML = createTemplate();
  const shell = root.querySelector<HTMLElement>(".app-shell");
  const form = root.querySelector<HTMLFormElement>("form.controls");
  const languageSelect = root.querySelector<HTMLSelectElement>("select[name='language']");
  const fromInput = root.querySelector<HTMLInputElement>("input[name='from']");
  const toInput = root.querySelector<HTMLInputElement>("input[name='to']");
  const message = root.querySelector<HTMLElement>("[data-message]");
  const summary = root.querySelector<HTMLElement>("[data-summary]");
  const metadata = root.querySelector<HTMLElement>("[data-metadata]");
  const chart = root.querySelector<HTMLElement>("[data-chart]");
  const table = root.querySelector<HTMLElement>("[data-table]");

  if (
    shell === null ||
    form === null ||
    languageSelect === null ||
    fromInput === null ||
    toInput === null ||
    message === null ||
    summary === null ||
    metadata === null ||
    chart === null ||
    table === null
  ) {
    throw new Error("Dashboard template is missing required elements.");
  }

  return {
    shell,
    form,
    languageSelect,
    fromInput,
    toInput,
    message,
    summary,
    metadata,
    chart,
    table,
  };
}

function setShellState(shell: HTMLElement, nextState: "loading" | "ready" | "error" | "empty"): void {
  shell.classList.remove(STATE_CLASS_LOADING, STATE_CLASS_ERROR, STATE_CLASS_EMPTY);
  if (nextState === "loading") {
    shell.classList.add(STATE_CLASS_LOADING);
  } else if (nextState === "error") {
    shell.classList.add(STATE_CLASS_ERROR);
  } else if (nextState === "empty") {
    shell.classList.add(STATE_CLASS_EMPTY);
  }
}

function renderLanguageOptions(select: HTMLSelectElement, languages: PublicLanguage[]): void {
  const { active, retired } = partitionLanguages(languages);
  const fragment = document.createDocumentFragment();

  const appendGroup = (label: string, groupLanguages: PublicLanguage[], retiredGroup: boolean): void => {
    if (groupLanguages.length === 0) {
      return;
    }

    const group = document.createElement("optgroup");
    group.label = label;

    for (const language of groupLanguages) {
      const option = document.createElement("option");
      option.value = language.id;
      option.textContent = retiredGroup
        ? `${language.label} (${language.id}, retired ${language.active_to})`
        : `${language.label} (${language.id})`;
      group.appendChild(option);
    }

    fragment.appendChild(group);
  };

  appendGroup("Active languages", active, false);
  appendGroup("Retired languages", retired, true);
  select.replaceChildren(fragment);
}

function renderMetadataNote(target: HTMLElement, metadata: MetadataResponse, latestObservedDate: string | null): void {
  const defaultRange = computeDefaultRange(metadata.launch_date, latestObservedDate);
  target.innerHTML = `
    <p>Available from launch date only: <strong>${metadata.launch_date}</strong>.</p>
    <p>Snapshots are observed during the UTC day, and missing dates are valid.</p>
    <p>Default view uses the last ${DEFAULT_RANGE_DAYS} days when available: <strong>${defaultRange.from}</strong> to <strong>${defaultRange.to}</strong>.</p>
  `;
}

function renderSnapshotTable(target: HTMLElement, quality: QualityResponse): void {
  const latestPoint = quality.series[quality.series.length - 1];
  if (latestPoint === undefined) {
    target.replaceChildren();
    return;
  }

  const table = document.createElement("table");
  table.innerHTML = `
    <caption>Latest published snapshot in range</caption>
    <thead>
      <tr>
        <th scope="col">Threshold</th>
        <th scope="col">Repositories</th>
      </tr>
    </thead>
    <tbody>
      ${latestPoint.thresholds
        .map(
          (threshold) =>
            `<tr><th scope="row">&gt;= ${threshold.threshold_value} stars</th><td>${threshold.count}</td></tr>`,
        )
        .join("")}
    </tbody>
  `;

  target.replaceChildren(table);
}

function renderEmpty(elements: DashboardElements, message: string): void {
  setShellState(elements.shell, "empty");
  elements.message.textContent = message;
  elements.summary.textContent = "No published snapshots match this range yet.";
  elements.chart.replaceChildren();
  elements.table.replaceChildren();
}

function renderError(elements: DashboardElements, message: string): void {
  setShellState(elements.shell, "error");
  elements.message.textContent = message;
  elements.summary.textContent = "The chart could not be loaded.";
  elements.chart.replaceChildren();
  elements.table.replaceChildren();
}

function renderLoading(elements: DashboardElements, message: string): void {
  setShellState(elements.shell, "loading");
  elements.message.textContent = message;
}

function renderSuccess(elements: DashboardElements, quality: QualityResponse): void {
  setShellState(elements.shell, "ready");
  const latestPoint = quality.series[quality.series.length - 1];

  if (latestPoint === undefined) {
    renderEmpty(elements, "No published snapshots are available for this language in the selected UTC range.");
    return;
  }

  elements.message.textContent = "";
  elements.summary.textContent = `Latest snapshot in range: ${latestPoint.observed_date}, observed at ${latestPoint.observed_at}, published at ${latestPoint.published_at}.`;
  renderQualityChart(elements.chart, {
    languageLabel: quality.language.label,
    points: quality.series,
  });
  renderSnapshotTable(elements.table, quality);
}

function validateRange(from: string, to: string): string | null {
  if (from === "" || to === "") {
    return "Choose a complete UTC date range.";
  }

  if (compareDates(from, to) > 0) {
    return "From must be on or before To.";
  }

  return null;
}

export function createDashboard(root: HTMLElement, api: QualityApi = createQualityApi()): { init(): Promise<void> } {
  const elements = bindElements(root);
  // Rapid form submits must not race: each load aborts any still-pending
  // request so the last filter change always wins, regardless of network order.
  let currentRequest: AbortController | null = null;

  async function loadSeries(): Promise<void> {
    const validationError = validateRange(elements.fromInput.value, elements.toInput.value);
    if (validationError !== null) {
      renderError(elements, validationError);
      return;
    }

    renderLoading(elements, "Loading published snapshots…");

    currentRequest?.abort();
    const request = new AbortController();
    currentRequest = request;

    try {
      const quality = await api.getQuality({
        language: elements.languageSelect.value,
        from: elements.fromInput.value,
        to: elements.toInput.value,
        signal: request.signal,
      });
      if (request.signal.aborted) {
        return;
      }
      renderSuccess(elements, quality);
    } catch (error) {
      if (request.signal.aborted) {
        return;
      }
      renderError(elements, getErrorMessage(error));
    }
  }

  async function init(): Promise<void> {
    renderLoading(elements, "Loading dataset metadata…");

    try {
      const [metadata, latest] = await Promise.all([api.getMetadata(), api.getLatest()]);

      renderLanguageOptions(elements.languageSelect, metadata.languages);
      if (metadata.languages.length > 0) {
        elements.languageSelect.value = metadata.languages[0].id;
      }

      const defaultRange = computeDefaultRange(metadata.launch_date, latest.observed_date);
      elements.fromInput.value = defaultRange.from;
      elements.toInput.value = defaultRange.to;
      renderMetadataNote(elements.metadata, metadata, latest.observed_date);

      if (metadata.languages.length === 0) {
        renderEmpty(elements, "No public languages are configured.");
        return;
      }

      await loadSeries();
    } catch (error) {
      renderError(elements, getErrorMessage(error));
    }
  }

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void loadSeries();
  });

  return { init };
}

const root = document.querySelector<HTMLElement>("[data-app-root]");
if (root !== null) {
  void createDashboard(root, createQualityApi()).init();
}
