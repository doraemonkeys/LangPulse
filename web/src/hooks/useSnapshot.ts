import { useQuery } from "@tanstack/react-query";
import { useQualityApi } from "./useQualityApi";
import type { SnapshotResponse } from "../api/types";

interface UseSnapshotArgs {
  date: string | null;
  threshold: number;
}

export function useSnapshot({ date, threshold }: UseSnapshotArgs) {
  const api = useQualityApi();
  return useQuery<SnapshotResponse>({
    queryKey: ["snapshot", date, threshold],
    queryFn: ({ signal }) => {
      if (date === null) {
        throw new Error("date is required to fetch a snapshot.");
      }
      return api.getSnapshot({ date, threshold, signal });
    },
    enabled: date !== null,
  });
}
