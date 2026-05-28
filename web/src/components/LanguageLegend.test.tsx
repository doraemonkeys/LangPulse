import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LanguageLegend } from "./LanguageLegend";

describe("LanguageLegend", () => {
  it("renders chips and toggles on click", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <LanguageLegend
        languages={[
          { id: "go", label: "Go" },
          { id: "rust", label: "Rust" },
        ]}
        palette={new Map([["go", "#E69F00"], ["rust", "#56B4E9"]])}
        pinnedLanguages={new Set(["go"])}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByRole("button", { name: /Go.*pinned/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: /Rust \(transient\)/ }));
    expect(onToggle).toHaveBeenCalledWith("rust");
  });

  it("marks chips whose language has no relative-mode baseline as unavailable", () => {
    render(
      <LanguageLegend
        languages={[
          { id: "go", label: "Go" },
          { id: "nascent", label: "Nascent" },
        ]}
        palette={new Map([["go", "#E69F00"], ["nascent", "#56B4E9"]])}
        pinnedLanguages={new Set()}
        onToggle={() => {}}
        unavailableByLanguage={new Map([["nascent", "zero_baseline"]])}
      />,
    );
    const nascent = screen.getByRole("button", { name: /Nascent.*Baseline is zero/ });
    const chip = nascent.closest(".legend-chip");
    expect(chip).toHaveClass("legend-chip--unavailable");
    expect(chip).toHaveAttribute("title", "Baseline is zero — no relative change to show");
    const goChip = screen.getByRole("button", { name: /^Go \(/ }).closest(".legend-chip");
    expect(goChip).not.toHaveClass("legend-chip--unavailable");
  });

  it("omits the remove button when onRemove is not provided", () => {
    render(
      <LanguageLegend
        languages={[{ id: "go", label: "Go" }]}
        palette={new Map([["go", "#E69F00"]])}
        pinnedLanguages={new Set()}
        onToggle={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /Remove Go from chart/ })).toBeNull();
  });

  it("renders a remove button per chip and forwards the language id on click", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <LanguageLegend
        languages={[
          { id: "go", label: "Go" },
          { id: "rust", label: "Rust" },
        ]}
        palette={new Map([["go", "#E69F00"], ["rust", "#56B4E9"]])}
        pinnedLanguages={new Set()}
        onToggle={() => {}}
        onRemove={onRemove}
      />,
    );
    const removeRust = screen.getByRole("button", { name: /Remove Rust from chart/ });
    await user.click(removeRust);
    expect(onRemove).toHaveBeenCalledWith("rust");
  });
});
