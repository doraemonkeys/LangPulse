import { createContext, useContext } from "react";
import type { QualityApi } from "../api/types";

const QualityApiContext = createContext<QualityApi | null>(null);

export const QualityApiProvider = QualityApiContext.Provider;

export function useQualityApi(): QualityApi {
  const api = useContext(QualityApiContext);
  if (api === null) {
    throw new Error("useQualityApi must be used within a QualityApiProvider.");
  }
  return api;
}
