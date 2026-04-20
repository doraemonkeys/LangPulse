import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// Recharts' ResponsiveContainer measures element dimensions before rendering
// children. jsdom reports zeroes for those measurements, so the chart never
// materializes in tests. Stubbing ResizeObserver + a fixed bounding box lets
// the component mount with deterministic dimensions.
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

if (typeof window !== "undefined") {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      return { width: 800, height: 360, top: 0, left: 0, right: 800, bottom: 360, x: 0, y: 0, toJSON() {} };
    },
  });

  if (typeof window.matchMedia === "undefined") {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }
}
