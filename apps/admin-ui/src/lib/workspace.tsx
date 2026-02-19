import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { trpc } from "./trpc";

const STORAGE_KEY = "synap_workspace_id";

interface Workspace {
  id: string;
  name: string;
  type: string;
  role: string;
}

interface WorkspaceState {
  workspaceId: string | null;
  workspaceRole: string | null;
  workspaces: Workspace[];
  isLoading: boolean;
  setWorkspace: (id: string) => void;
}

const WorkspaceContext = createContext<WorkspaceState>({
  workspaceId: null,
  workspaceRole: null,
  workspaces: [],
  isLoading: true,
  setWorkspace: () => {},
});

export function useWorkspace(): WorkspaceState {
  return useContext(WorkspaceContext);
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaceId, setWorkspaceIdState] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY)
  );

  // Auth is guaranteed by AuthProvider gating children — always enabled here
  const { data: workspacesRaw, isLoading } = trpc.workspaces.list.useQuery();

  const workspaces: Workspace[] = useMemo(
    () =>
      (workspacesRaw ?? []).map((w) => ({
        id: w.id,
        name: w.name,
        type: w.type,
        role: w.role,
      })),
    [workspacesRaw]
  );

  // Auto-select first workspace if none stored or stored one is invalid
  useEffect(() => {
    if (isLoading || workspaces.length === 0) return;
    const stored = localStorage.getItem(STORAGE_KEY);
    const valid = workspaces.some((w) => w.id === stored);
    if (!stored || !valid) {
      const first = workspaces[0].id;
      localStorage.setItem(STORAGE_KEY, first);
      setWorkspaceIdState(first);
    }
  }, [isLoading, workspaces]);

  const setWorkspace = useCallback((id: string) => {
    localStorage.setItem(STORAGE_KEY, id);
    setWorkspaceIdState(id);
  }, []);

  const currentWorkspace = workspaces.find((w) => w.id === workspaceId);

  const value = useMemo(
    () => ({
      workspaceId,
      workspaceRole: currentWorkspace?.role ?? null,
      workspaces,
      isLoading,
      setWorkspace,
    }),
    [workspaceId, currentWorkspace?.role, workspaces, isLoading, setWorkspace]
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
