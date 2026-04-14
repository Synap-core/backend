import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import { ToastProvider } from "@heroui/react";
import { BrowserRouter } from "react-router-dom";
import { trpc, trpcClient } from "./lib/trpc";
import App from "./App";
import GlobalErrorBoundary from "./components/error/GlobalErrorBoundary";
import { AuthProvider } from "./lib/auth";
import { WorkspaceProvider } from "./lib/workspace";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const TRPCProvider = trpc.Provider;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TRPCProvider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider placement="top end" maxVisibleToasts={4}>
          {/* Mantine: legacy pages until migrated to Hero UI + Tailwind */}
          <MantineProvider>
            <GlobalErrorBoundary>
              <BrowserRouter basename="/admin">
                <AuthProvider>
                  <WorkspaceProvider>
                    <App />
                  </WorkspaceProvider>
                </AuthProvider>
              </BrowserRouter>
            </GlobalErrorBoundary>
          </MantineProvider>
        </ToastProvider>
      </QueryClientProvider>
    </TRPCProvider>
  </StrictMode>
);
