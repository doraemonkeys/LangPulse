import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Leaderboard } from "./Leaderboard";
import type { SnapshotResponse } from "../api/types";

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

describe("Leaderboard", () => {
  it("renders skeleton while loading", () => {
    render(
      <Leaderboard
        snapshot={undefined}
        isLoading={true}
        error={null}
        sparklineData={undefined}
        theme="light"
        pinnedLanguages={new Set()}
        onTogglePin={() => {}}
        onResetPins={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
  });

  it("renders up to 10 rows sorted desc and shows reset button when pinned", async () => {
    const user = userEvent.setup();
    const onTogglePin = vi.fn();
    const onResetPins = vi.fn();
    render(
      <Leaderboard
        snapshot={snapshot}
        isLoading={false}
        error={null}
        sparklineData={undefined}
        theme="light"
        pinnedLanguages={new Set(["lang0"])}
        onTogglePin={onTogglePin}
        onResetPins={onResetPins}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    const resetButton = screen.getByRole("button", { name: /Reset/ });
    await user.click(resetButton);
    expect(onResetPins).toHaveBeenCalled();
  });

  it("renders the empty banner when the snapshot has no languages", () => {
    render(
      <Leaderboard
        snapshot={{ ...snapshot, languages: [] }}
        isLoading={false}
        error={null}
        sparklineData={undefined}
        theme="light"
        pinnedLanguages={new Set()}
        onTogglePin={() => {}}
        onResetPins={() => {}}
      />,
    );
    expect(screen.getByText(/No languages at this threshold/)).toBeInTheDocument();
  });

  it("renders the error banner", () => {
    render(
      <Leaderboard
        snapshot={undefined}
        isLoading={false}
        error={new Error("boom")}
        sparklineData={undefined}
        theme="light"
        pinnedLanguages={new Set()}
        onTogglePin={() => {}}
        onResetPins={() => {}}
      />,
    );
    expect(screen.getByText("Could not load leaderboard")).toBeInTheDocument();
  });
});
