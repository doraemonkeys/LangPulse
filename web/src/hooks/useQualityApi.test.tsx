import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { QualityApiProvider, useQualityApi } from "./useQualityApi";
import { createFakeApi, SAMPLE_METADATA } from "../test-utils/fakeApi";

describe("useQualityApi", () => {
  it("returns the provided api instance", () => {
    const { api } = createFakeApi({ metadata: SAMPLE_METADATA });
    const { result } = renderHook(() => useQualityApi(), {
      wrapper: ({ children }) => (
        <QualityApiProvider value={api}>{children}</QualityApiProvider>
      ),
    });

    expect(result.current).toBe(api);
  });

  it("throws when used without a provider", () => {
    expect(() => renderHook(() => useQualityApi())).toThrow();
  });
});
