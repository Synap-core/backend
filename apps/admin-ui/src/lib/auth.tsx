import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";

const IS_DEV = import.meta.env.DEV;
// In production, admin-ui is same-origin with the backend — use relative paths.
// In dev, VITE_API_URL points to the backend.
const API_URL = import.meta.env.VITE_API_URL || "";

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

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() =>
    IS_DEV
      ? { id: "admin-ui-dev-user", email: "dev@synap.local", name: "Dev User" }
      : null
  );
  const [isLoading, setIsLoading] = useState(() => !IS_DEV);

  useEffect(() => {
    // In dev mode, already initialised via lazy state
    if (IS_DEV) return;

    // Guard against StrictMode double-fire
    let cancelled = false;

    // Check Kratos session
    fetch(`${API_URL}/.ory/kratos/public/sessions/whoami`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          // Not authenticated — redirect to Kratos login
          const returnTo = encodeURIComponent(window.location.href);
          window.location.href = `${API_URL}/.ory/kratos/public/self-service/login/browser?return_to=${returnTo}`;
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
      .catch(() => {
        if (cancelled) return;
        // Kratos unreachable — redirect to login
        const returnTo = encodeURIComponent(window.location.href);
        window.location.href = `${API_URL}/.ory/kratos/public/self-service/login/browser?return_to=${returnTo}`;
      });
    // Don't setIsLoading(false) on redirect paths — page is navigating away
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(() => {
    fetch(`${API_URL}/.ory/kratos/public/self-service/logout/browser`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          if (data.logout_url) {
            window.location.href = data.logout_url;
            return;
          }
        }
        setUser(null);
        window.location.href = `${API_URL}/.ory/kratos/public/self-service/login/browser`;
      })
      .catch(() => {
        setUser(null);
        window.location.href = `${API_URL}/.ory/kratos/public/self-service/login/browser`;
      });
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        logout,
      }}
    >
      {/* Don't render children until auth check completes — prevents premature queries */}
      {isLoading ? null : children}
    </AuthContext.Provider>
  );
}
