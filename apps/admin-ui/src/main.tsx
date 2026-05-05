import {
  StrictMode,
  useEffect,
  useState,
  createContext,
  useContext,
} from "react";
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

const THEME_KEY = "synap-admin-theme";

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getSavedTheme(): "light" | "dark" | null {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  return null;
}

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    return getSavedTheme() ?? getSystemTheme();
  });

  useEffect(() => {
    const html = document.documentElement;
    html.classList.remove("light", "dark");
    html.classList.add(theme);
    html.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      if (getSavedTheme() === null) {
        setTheme(e.matches ? "dark" : "light");
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return {
    theme,
    setTheme,
    toggleTheme: () => setTheme((t) => (t === "light" ? "dark" : "light")),
  };
}

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

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme, toggleTheme } = useTheme();
  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

const ThemeContext = createContext<{
  theme: "light" | "dark";
  toggleTheme: () => void;
} | null>(null);

export function useThemeContext() {
  const ctx = useContext(ThemeContext);
  if (!ctx)
    throw new Error("useThemeContext must be used within ThemeProvider");
  return ctx;
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  renderFatal("Missing #root element.");
} else {
  // The admin-ui is deprecated (see App.tsx). Three routes are preserved
  // and need their normal provider stack: /admin/kratos, /admin/bootstrap,
  // /admin/connect. Everything else renders <DeprecationRedirect />, which
  // does a window.location.replace to Pod Admin and needs zero providers
  // — skipping AuthProvider/WorkspaceProvider here matters because those
  // talk to tRPC and would otherwise log noise + fight a session that the
  // operator no longer has.
  const pathname = window.location.pathname;
  const isPublicAdminPath =
    pathname.endsWith("/admin/kratos") ||
    pathname.endsWith("/admin/bootstrap") ||
    pathname.endsWith("/admin/connect") ||
    pathname === "/admin/kratos" ||
    pathname === "/admin/bootstrap" ||
    pathname === "/admin/connect";

  // Apply theme immediately to avoid flash
  const initialTheme = getSavedTheme() ?? getSystemTheme();
  const html = document.documentElement;
  html.classList.remove("light", "dark");
  html.classList.add(initialTheme);
  html.setAttribute("data-theme", initialTheme);

  try {
    createRoot(rootEl).render(
      <StrictMode>
        <GlobalErrorBoundary>
          <TRPCProvider client={trpcClient} queryClient={queryClient}>
            <QueryClientProvider client={queryClient}>
              <ToastProvider placement="top end" maxVisibleToasts={4} />
              <ThemeProvider>
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
              </ThemeProvider>
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
