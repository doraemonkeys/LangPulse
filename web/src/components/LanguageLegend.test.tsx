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
    await user.click(screen.getByRole("button", { name: /Rust/ }));
    expect(onToggle).toHaveBeenCalledWith("rust");
  });
});
