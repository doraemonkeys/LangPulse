import { useQuery } from "@tanstack/react-query";
import { useQualityApi } from "./useQualityApi";
import type { LatestSnapshotResponse } from "../api/types";

const LATEST_STALE_TIME_MS = 60 * 1000;

export function useLatest() {
  const api = useQualityApi();
  return useQuery<LatestSnapshotResponse>({
    queryKey: ["latest"],
    queryFn: ({ signal }) => api.getLatest(signal),
    staleTime: LATEST_STALE_TIME_MS,
  });
}
