import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTheme } from "./useTheme";

type ChangeListener = (event: MediaQueryListEvent) => void;

interface MockMediaQueryList {
  matches: boolean;
  listeners: Set<ChangeListener>;
  setMatches(next: boolean): void;
}

function installMatchMediaMock(initialMatches: boolean): MockMediaQueryList {
  const state: MockMediaQueryList = {
    matches: initialMatches,
    listeners: new Set(),
    setMatches(next: boolean) {
      state.matches = next;
      const event = { matches: next, media: "(prefers-color-scheme: dark)" } as MediaQueryListEvent;
      state.listeners.forEach((listener) => listener(event));
    },
  };
  window.matchMedia = vi.fn().mockImplementation(() => ({
    get matches() {
      return state.matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_event: string, listener: ChangeListener) => {
      state.listeners.add(listener);
    }),
    removeEventListener: vi.fn((_event: string, listener: ChangeListener) => {
      state.listeners.delete(listener);
    }),
    dispatchEvent: vi.fn(),
  }));
  return state;
}

describe("useTheme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to system preference and resolves via matchMedia", () => {
    installMatchMediaMock(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe("system");
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("langpulse:theme")).toBe("system");
  });

  it("resolves system to dark when the OS reports prefers-color-scheme: dark", () => {
    installMatchMediaMock(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe("system");
    expect(result.current.theme).toBe("dark");
  });

  it("reads a stored explicit preference when present", () => {
    installMatchMediaMock(false);
    window.localStorage.setItem("langpulse:theme", "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe("dark");
    expect(result.current.theme).toBe("dark");
  });

  it("setPreference persists the choice and resolves the theme", () => {
    installMatchMediaMock(false);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPreference("dark"));
    expect(result.current.preference).toBe("dark");
    expect(result.current.theme).toBe("dark");
    expect(window.localStorage.getItem("langpulse:theme")).toBe("dark");

    act(() => result.current.setPreference("system"));
    expect(result.current.preference).toBe("system");
    expect(result.current.theme).toBe("light");
  });

  it("follows OS theme changes only while preference is system", () => {
    const mql = installMatchMediaMock(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");

    act(() => mql.setMatches(true));
    expect(result.current.theme).toBe("dark");

    // Pin to light → unsubscribe; subsequent OS changes must not flip the theme.
    act(() => result.current.setPreference("light"));
    expect(result.current.theme).toBe("light");
    act(() => mql.setMatches(false));
    expect(result.current.theme).toBe("light");
    act(() => mql.setMatches(true));
    expect(result.current.theme).toBe("light");
  });
});
