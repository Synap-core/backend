import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type CSSProperties,
  type ReactNode,
} from "react";

const IS_DEV = import.meta.env.DEV;
// In production, admin-ui is same-origin with the backend — use relative paths.
// In dev, VITE_API_URL points to the backend.
const API_URL = import.meta.env.VITE_API_URL || "";

/** Kratos browser login URL (same-origin in production). */
function loginBrowserUrl(): string {
  const returnTo = encodeURIComponent(window.location.href);
  return `${API_URL}/.ory/kratos/public/self-service/login/browser?return_to=${returnTo}`;
}

const WHOAMI_TIMEOUT_MS = 20_000;

/** No HeroUI/Tailwind — always visible even if design-system CSS fails. */
const bootShell: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  textAlign: "center",
  background: "#e4e4e7",
  color: "#18181b",
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

const spinnerStyle: CSSProperties = {
  width: 36,
  height: 36,
  border: "3px solid #d4d4d8",
  borderTopColor: "#d97706",
  borderRadius: "50%",
  animation: "synap-auth-spin 0.75s linear infinite",
};

const btnStyle: CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  border: "1px solid #d4d4d8",
  background: "#fff",
  cursor: "pointer",
  fontSize: 14,
  margin: 4,
};

const btnPrimaryStyle: CSSProperties = {
  ...btnStyle,
  background: "#18181b",
  color: "#fafafa",
  borderColor: "#18181b",
};

interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  logout: () => {},
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

function AuthBootShell({ message }: { message: string }) {
  return (
    <div style={bootShell}>
      <style>{`@keyframes synap-auth-spin { to { transform: rotate(360deg); } }`}</style>
      <div style={spinnerStyle} aria-hidden />
      <p
        style={{
          maxWidth: 420,
          marginTop: 16,
          fontSize: 14,
          lineHeight: 1.5,
          color: "#3f3f46",
        }}
      >
        {message}
      </p>
    </div>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() =>
    IS_DEV
      ? { id: "admin-ui-dev-user", email: "dev@synap.local", name: "Dev User" }
      : null
  );
  const [isLoading, setIsLoading] = useState(() => !IS_DEV);
  const [bootError, setBootError] = useState<string | null>(null);
  const [sessionCheckKey, setSessionCheckKey] = useState(0);

  useEffect(() => {
    if (IS_DEV) return;

    let cancelled = false;
    let timedOut = false;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, WHOAMI_TIMEOUT_MS);

    fetch(`${API_URL}/.ory/kratos/public/sessions/whoami`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (cancelled) return;
        window.clearTimeout(timeoutId);
        if (!res.ok) {
          window.location.assign(loginBrowserUrl());
          return;
        }
        const session = (await res.json()) as {
          identity?: { id: string; traits?: { email?: string; name?: string } };
        };
        const identity = session.identity;
        if (identity && !cancelled) {
          setUser({
            id: identity.id,
            email: identity.traits?.email ?? "",
            name: identity.traits?.name,
          });
        }
        if (!cancelled) setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        window.clearTimeout(timeoutId);
        const name =
          err && typeof err === "object" && "name" in err
            ? String((err as { name: string }).name)
            : "";
        if (name === "AbortError" && timedOut) {
          setBootError(
            "Could not verify your session in time. Usually this means Ory Kratos is not reachable at `/.ory/kratos/public/` on this host, or the reverse proxy is misconfigured."
          );
          setIsLoading(false);
          return;
        }
        if (name === "AbortError") return;
        window.location.assign(loginBrowserUrl());
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [sessionCheckKey]);

  const retrySessionCheck = useCallback(() => {
    setBootError(null);
    setUser(null);
    setIsLoading(true);
    setSessionCheckKey((k) => k + 1);
  }, []);

  const logout = useCallback(() => {
    fetch(`${API_URL}/.ory/kratos/public/self-service/logout/browser`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as { logout_url?: string };
          if (data.logout_url) {
            window.location.href = data.logout_url;
            return;
          }
        }
        setUser(null);
        window.location.href = loginBrowserUrl();
      })
      .catch(() => {
        setUser(null);
        window.location.href = loginBrowserUrl();
      });
  }, []);

  const body = (() => {
    if (IS_DEV) return children;
    if (bootError) {
      return (
        <div style={bootShell}>
          <p
            style={{
              maxWidth: 480,
              margin: 0,
              fontSize: 14,
              lineHeight: 1.5,
              color: "#3f3f46",
            }}
          >
            {bootError}
          </p>
          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              style={btnPrimaryStyle}
              onClick={retrySessionCheck}
            >
              Try again
            </button>
            <button
              type="button"
              style={btnStyle}
              onClick={() => window.location.assign(loginBrowserUrl())}
            >
              Open sign-in
            </button>
          </div>
        </div>
      );
    }
    if (isLoading) {
      return (
        <AuthBootShell message="Checking your session… If you are not signed in, you will be redirected to the login page." />
      );
    }
    return children;
  })();

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        logout,
      }}
    >
      {body}
    </AuthContext.Provider>
  );
}
