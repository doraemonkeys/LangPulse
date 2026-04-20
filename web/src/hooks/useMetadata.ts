import { useQuery } from "@tanstack/react-query";
import { useQualityApi } from "./useQualityApi";
import type { MetadataResponse } from "../api/types";

export function useMetadata() {
  const api = useQualityApi();
  return useQuery<MetadataResponse>({
    queryKey: ["metadata"],
    queryFn: ({ signal }) => api.getMetadata(signal),
  });
}
