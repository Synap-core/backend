import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { BrowserRouter } from "react-router-dom";
import { trpc, trpcClient } from "./lib/trpc";
import App from "./App";
import GlobalErrorBoundary from "./components/error/GlobalErrorBoundary";

// Import Mantine styles
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";
import "./index.css";

// Create QueryClient for React Query
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
        <MantineProvider>
          <GlobalErrorBoundary>
            <Notifications position="top-right" zIndex={1000} />
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </GlobalErrorBoundary>
        </MantineProvider>
      </QueryClientProvider>
    </TRPCProvider>
  </StrictMode>
);
