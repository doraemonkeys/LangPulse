import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { createQualityApi } from "./api/client";
import { createAppQueryClient } from "./api/queryClient";
import { QualityApiProvider } from "./hooks/useQualityApi";
import { DashboardProvider } from "./state/DashboardProvider";
import "./theme/reset.css";
import "./theme/tokens.css";
import "./theme/app.css";

const root = document.querySelector<HTMLElement>("[data-app-root]");
if (root !== null) {
  const queryClient = createAppQueryClient();
  const qualityApi = createQualityApi();

  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <QualityApiProvider value={qualityApi}>
          <DashboardProvider>
            <App />
          </DashboardProvider>
        </QualityApiProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
