import { useQuery } from "@tanstack/react-query";
import { useQualityApi } from "./useQualityApi";
import type { CompareResponse } from "../api/types";

interface UseCompareArgs {
  languages: string[];
  threshold: number;
  from: string;
  to: string;
}

export function useCompare({ languages, threshold, from, to }: UseCompareArgs) {
  const api = useQualityApi();
  const sortedLanguages = [...languages].sort();

  return useQuery<CompareResponse>({
    queryKey: ["compare", sortedLanguages.join(","), threshold, from, to],
    queryFn: ({ signal }) =>
      api.getCompare({ languages: sortedLanguages, threshold, from, to, signal }),
    enabled: languages.length > 0 && from !== "" && to !== "",
  });
}
