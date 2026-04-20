import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Leaderboard } from "./Leaderboard";
import { MAX_PINNED_LANGUAGES } from "../state/actions";
import type { PublicLanguage, SnapshotResponse } from "../api/types";

const snapshot: SnapshotResponse = {
  observed_date: "2026-04-10",
  threshold: 2,
  previous_date: "2026-04-09",
  languages: Array.from({ length: 12 }, (_, index) => ({
    id: `lang${index}`,
    label: `Lang ${index}`,
    count: 1000 - index * 10,
    previous_count: 900 - index * 10,
  })),
};

const registry: PublicLanguage[] = snapshot.languages.map((entry) => ({
  id: entry.id,
  label: entry.label,
  active_from: "2026-04-01",
  active_to: null,
}));

function defaultProps() {
  return {
    snapshot,
    isLoading: false,
    error: null,
    sparklineData: undefined,
    theme: "light" as const,
    pinnedLanguages: new Set<string>(),
    onTogglePin: () => {},
    onResetPins: () => {},
    registryLanguages: registry,
    observedDate: "2026-04-10" as string | null,
  };
}

describe("Leaderboard", () => {
  it("renders skeleton while loading", () => {
    render(
      <Leaderboard
        {...defaultProps()}
        snapshot={undefined}
        isLoading={true}
      />,
    );
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
  });

  it("renders up to 10 rows sorted desc and shows reset button when pinned", async () => {
    const user = userEvent.setup();
    const onResetPins = vi.fn();
    render(
      <Leaderboard
        {...defaultProps()}
        pinnedLanguages={new Set(["lang0"])}
        onResetPins={onResetPins}
      />,
    );
    const topListItems = screen
      .getAllByRole("listitem")
      .filter((item) => item.closest(".leaderboard__rows--more") === null);
    expect(topListItems).toHaveLength(10);
    const resetButton = screen.getByRole("button", { name: /Reset/ });
    await user.click(resetButton);
    expect(onResetPins).toHaveBeenCalled();
  });

  it("renders the empty banner when the snapshot has no languages", () => {
    render(
      <Leaderboard
        {...defaultProps()}
        snapshot={{ ...snapshot, languages: [] }}
      />,
    );
    expect(screen.getByText(/No languages at this threshold/)).toBeInTheDocument();
  });

  it("renders the error banner", () => {
    render(
      <Leaderboard
        {...defaultProps()}
        snapshot={undefined}
        error={new Error("boom")}
      />,
    );
    expect(screen.getByText("Could not load leaderboard")).toBeInTheDocument();
  });

  it("reveals rows 11+ when Show all is clicked and collapses on Show less", async () => {
    const user = userEvent.setup();
    const onTogglePin = vi.fn();
    render(<Leaderboard {...defaultProps()} onTogglePin={onTogglePin} />);

    const showAll = screen.getByRole("button", { name: /Show all 12 languages/ });
    expect(screen.queryByText("Lang 11")).not.toBeInTheDocument();
    await user.click(showAll);
    expect(screen.getByText("Lang 11")).toBeInTheDocument();

    // Row 12 is clickable and pins its language.
    const row12 = screen.getByRole("button", { name: /Lang 11,/ });
    await user.click(row12);
    expect(onTogglePin).toHaveBeenCalledWith("lang11");

    await user.click(screen.getByRole("button", { name: /Show less/ }));
    expect(screen.queryByText("Lang 11")).not.toBeInTheDocument();
  });

  it("omits Show all button when the list has 10 or fewer languages", () => {
    const slim: SnapshotResponse = {
      ...snapshot,
      languages: snapshot.languages.slice(0, 8),
    };
    render(<Leaderboard {...defaultProps()} snapshot={slim} />);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("disables unpinned rows when pinned set is at the cap", async () => {
    const user = userEvent.setup();
    const onTogglePin = vi.fn();
    const pinned = new Set(
      Array.from({ length: MAX_PINNED_LANGUAGES }, (_, index) => `pinned${index}`),
    );
    render(
      <Leaderboard
        {...defaultProps()}
        pinnedLanguages={pinned}
        onTogglePin={onTogglePin}
      />,
    );
    const firstRow = screen.getByRole("button", { name: /Lang 0,/ });
    expect(firstRow).toHaveAttribute("aria-disabled", "true");
    await user.click(firstRow);
    expect(onTogglePin).not.toHaveBeenCalled();
  });

  it("hosts the language picker in the header", () => {
    render(<Leaderboard {...defaultProps()} />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});
