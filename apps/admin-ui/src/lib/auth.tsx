import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import KratosSelfServicePage from "../pages/KratosSelfServicePage";
import { logout as kratosLogout, whoami } from "./kratos";

const IS_DEV = import.meta.env.DEV;

const WHOAMI_TIMEOUT_MS = 20_000;

// No HeroUI/Tailwind — always visible even if design-system CSS fails.
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

type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "error";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() =>
    IS_DEV
      ? { id: "admin-ui-dev-user", email: "dev@synap.local", name: "Dev User" }
      : null
  );
  const [status, setStatus] = useState<AuthStatus>(() =>
    IS_DEV ? "authenticated" : "loading"
  );
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

    void (async () => {
      try {
        const session = await whoami(controller.signal);
        if (cancelled) return;
        window.clearTimeout(timeoutId);
        if (!session) {
          setStatus("unauthenticated");
          return;
        }
        const identity = session.identity;
        setUser({
          id: identity.id,
          email: identity.traits?.email ?? "",
          name: identity.traits?.name,
        });
        setStatus("authenticated");
      } catch (err: unknown) {
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
          setStatus("error");
          return;
        }
        if (name === "AbortError") return;
        // Any other error (e.g. network) — treat as unauthenticated and let
        // the inline Kratos UI surface a clearer retry path.
        setStatus("unauthenticated");
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [sessionCheckKey]);

  const retrySessionCheck = useCallback(() => {
    setBootError(null);
    setUser(null);
    setStatus("loading");
    setSessionCheckKey((k) => k + 1);
  }, []);

  const logout = useCallback(async () => {
    const ok = await kratosLogout();
    if (!ok) {
      setUser(null);
      setStatus("unauthenticated");
    }
  }, []);

  const body = (() => {
    if (IS_DEV) return children;
    if (status === "error" && bootError) {
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
          </div>
        </div>
      );
    }
    if (status === "loading") {
      return <AuthBootShell message="Checking your session…" />;
    }
    if (status === "unauthenticated") {
      // Render the Kratos login form inline — no full-page redirect through
      // Kratos's /browser endpoint. KratosSelfServicePage creates a fresh
      // login flow via JSON API and reloads on success so whoami succeeds.
      return <KratosSelfServicePage initialKind="login" />;
    }
    return children;
  })();

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading: status === "loading",
        isAuthenticated: !!user,
        logout,
      }}
    >
      {body}
    </AuthContext.Provider>
  );
}
