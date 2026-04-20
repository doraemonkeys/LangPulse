import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LanguagePicker } from "./LanguagePicker";
import type { PublicLanguage, SnapshotLanguageCount } from "../api/types";

const LANGUAGES: PublicLanguage[] = [
  { id: "go", label: "Go", active_from: "2026-04-01", active_to: null },
  { id: "rust", label: "Rust", active_from: "2026-04-01", active_to: null },
  { id: "ruby", label: "Ruby", active_from: "2026-04-01", active_to: null },
  { id: "python", label: "Python", active_from: "2026-04-01", active_to: null },
  { id: "retired", label: "Retired", active_from: "2026-01-01", active_to: "2026-02-01" },
];

const SNAPSHOT: SnapshotLanguageCount[] = [
  { id: "go", label: "Go", count: 1200, previous_count: 1000 },
  { id: "rust", label: "Rust", count: 900, previous_count: 800 },
];

function renderPicker(overrides: Partial<{
  pinnedLanguages: ReadonlySet<string>;
  maxPinned: number;
  onTogglePin: (id: string) => void;
  observedDate: string | null;
}> = {}) {
  const onTogglePin = overrides.onTogglePin ?? vi.fn();
  render(
    <LanguagePicker
      languages={LANGUAGES}
      snapshotEntries={SNAPSHOT}
      observedDate={overrides.observedDate ?? "2026-04-10"}
      pinnedLanguages={overrides.pinnedLanguages ?? new Set()}
      maxPinned={overrides.maxPinned ?? 20}
      onTogglePin={onTogglePin}
    />,
  );
  return { onTogglePin };
}

describe("LanguagePicker", () => {
  it("renders closed by default and opens on focus", async () => {
    const user = userEvent.setup();
    renderPicker();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // Retired language is filtered out; 4 active remain.
    expect(screen.getAllByRole("option")).toHaveLength(4);
  });

  it("filters by label and id substring, case-insensitive", async () => {
    const user = userEvent.setup();
    renderPicker();
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.type(input, "RB");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain("Ruby");
  });

  it("navigates options with arrow keys and Home/End, toggles on Enter", async () => {
    const user = userEvent.setup();
    const { onTogglePin } = renderPicker();
    const input = screen.getByRole("combobox");
    await user.click(input);
    // Options are sorted by label asc: Go, Python, Ruby, Rust.
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onTogglePin).toHaveBeenCalledWith("python");

    await user.keyboard("{End}");
    await user.keyboard("{Enter}");
    expect(onTogglePin).toHaveBeenCalledWith("rust");

    await user.keyboard("{Home}");
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Enter}");
    expect(onTogglePin).toHaveBeenCalledWith("rust");
  });

  it("marks pinned options and still allows unpin at cap", async () => {
    const user = userEvent.setup();
    const { onTogglePin } = renderPicker({
      pinnedLanguages: new Set(["go"]),
      maxPinned: 1,
    });
    await user.click(screen.getByRole("combobox"));
    const pinnedOption = screen.getByRole("option", { selected: true });
    expect(pinnedOption.textContent).toContain("Go");
    // At cap: unpinned options are aria-disabled and click is a no-op.
    const disabledOption = screen.getAllByRole("option").find(
      (el) => el.getAttribute("aria-disabled") === "true",
    );
    expect(disabledOption).toBeDefined();
    await user.click(disabledOption!);
    expect(onTogglePin).not.toHaveBeenCalled();
    // Pinned option remains interactive so the user can unpin.
    await user.click(pinnedOption);
    expect(onTogglePin).toHaveBeenCalledWith("go");
  });

  it("closes on Escape and on outside mousedown", async () => {
    const user = userEvent.setup();
    renderPicker();
    const input = screen.getByRole("combobox");
    await user.click(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows an empty-state message when the query has no match", async () => {
    const user = userEvent.setup();
    renderPicker();
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.type(input, "zzzz");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByText(/No languages match/)).toBeInTheDocument();
    // Enter on empty list is a no-op.
    await user.keyboard("{Enter}");
  });

  it("reopens the listbox when ArrowDown is pressed while closed", async () => {
    const user = userEvent.setup();
    renderPicker();
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    input.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("shows em-dash when a language has no snapshot entry", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("combobox"));
    const pythonOption = screen.getByRole("option", { name: /Python/ });
    expect(pythonOption.textContent).toContain("\u2014");
  });
});
