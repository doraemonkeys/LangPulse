import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LeaderboardRow } from "./LeaderboardRow";

const baseEntry = { id: "go", label: "Go", count: 1200, previous_count: 1000 };

describe("LeaderboardRow", () => {
  it("renders rank, label, count, and delta", () => {
    render(
      <LeaderboardRow
        rank={1}
        entry={baseEntry}
        sparklinePoints={[]}
        color="#E69F00"
        pinned={false}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("Go")).toBeInTheDocument();
    expect(screen.getByText("1,200")).toBeInTheDocument();
    expect(screen.getByText(/\+20/)).toBeInTheDocument();
  });

  it("toggles on click and Enter/Space keyboard activation", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <LeaderboardRow
        rank={2}
        entry={baseEntry}
        sparklinePoints={[]}
        color="#E69F00"
        pinned={true}
        onToggle={onToggle}
      />,
    );
    const row = screen.getByRole("button");
    await user.click(row);
    expect(onToggle).toHaveBeenCalledWith("go");

    row.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledTimes(3);
    expect(row).toHaveAttribute("aria-pressed", "true");
  });

  it("renders an em-dash for null previous_count", () => {
    render(
      <LeaderboardRow
        rank={5}
        entry={{ ...baseEntry, previous_count: null }}
        sparklinePoints={[]}
        color="#E69F00"
        pinned={false}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText("\u2014")).toBeInTheDocument();
  });
});
