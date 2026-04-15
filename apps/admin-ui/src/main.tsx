import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@heroui/react";
import { BrowserRouter } from "react-router-dom";
import { trpc, trpcClient } from "./lib/trpc";
import App from "./App";
import GlobalErrorBoundary from "./components/error/GlobalErrorBoundary";
import { AuthProvider } from "./lib/auth";
import { WorkspaceProvider } from "./lib/workspace";
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

function renderFatal(message: string, detail?: string) {
  const rootEl = document.getElementById("root");
  const text = detail ? `${message}\n\n${detail}` : message;
  if (rootEl) {
    rootEl.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif;background:#e4e4e7;color:#18181b;"><pre style="white-space:pre-wrap;max-width:560px;font-size:13px;line-height:1.5;margin:0;">${text.replace(/</g, "&lt;")}</pre></div>`;
  }
  console.error("[admin-ui bootstrap]", message, detail ?? "");
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  renderFatal("Missing #root element.");
} else {
  const pathname = window.location.pathname;
  const isPublicAdminPath =
    pathname.endsWith("/admin/kratos") ||
    pathname.endsWith("/admin/bootstrap") ||
    pathname === "/admin/kratos" ||
    pathname === "/admin/bootstrap";

  try {
    createRoot(rootEl).render(
      <StrictMode>
        <GlobalErrorBoundary>
          <TRPCProvider client={trpcClient} queryClient={queryClient}>
            <QueryClientProvider client={queryClient}>
              {/* ToastRegion renders null when the queue is empty — keep it a sibling, not a parent of the app. */}
              <ToastProvider placement="top end" maxVisibleToasts={4} />
              <BrowserRouter basename="/admin">
                {isPublicAdminPath ? (
                  <App />
                ) : (
                  <AuthProvider>
                    <WorkspaceProvider>
                      <App />
                    </WorkspaceProvider>
                  </AuthProvider>
                )}
              </BrowserRouter>
            </QueryClientProvider>
          </TRPCProvider>
        </GlobalErrorBoundary>
      </StrictMode>
    );
  } catch (e) {
    renderFatal(
      "Failed to start the admin UI (React createRoot/render threw).",
      e instanceof Error ? (e.stack ?? e.message) : String(e)
    );
  }
}
