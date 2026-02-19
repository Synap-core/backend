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

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // In dev mode with test user, skip Kratos check
    if (IS_DEV) {
      setUser({
        id: "admin-ui-dev-user",
        email: "dev@synap.local",
        name: "Dev User",
      });
      setIsLoading(false);
      return;
    }

    // Check Kratos session
    fetch(`${API_URL}/.ory/kratos/public/sessions/whoami`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) {
          // Not authenticated — redirect to Kratos login
          const returnTo = encodeURIComponent(window.location.href);
          window.location.href = `${API_URL}/.ory/kratos/public/self-service/login/browser?return_to=${returnTo}`;
          return;
        }
        const session = await res.json();
        const identity = session.identity;
        if (identity) {
          setUser({
            id: identity.id,
            email: identity.traits?.email ?? "",
            name: identity.traits?.name,
          });
        }
      })
      .catch(() => {
        // Kratos unreachable — redirect to login
        const returnTo = encodeURIComponent(window.location.href);
        window.location.href = `${API_URL}/.ory/kratos/public/self-service/login/browser?return_to=${returnTo}`;
      })
      .finally(() => setIsLoading(false));
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
        // Fallback: clear state and redirect to login
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
      {children}
    </AuthContext.Provider>
  );
}
