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
  workspaceName: string | null;
  workspaceRole: string | null;
  workspaces: Workspace[];
  isLoading: boolean;
  setWorkspace: (id: string) => void;
}

const WorkspaceContext = createContext<WorkspaceState>({
  workspaceId: null,
  workspaceName: null,
  workspaceRole: null,
  workspaces: [],
  isLoading: true,
  setWorkspace: () => {},
});

// eslint-disable-next-line react-refresh/only-export-components
export function useWorkspace(): WorkspaceState {
  return useContext(WorkspaceContext);
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
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

  // Derive effective workspace ID — auto-select first if selection is invalid
  const workspaceId = useMemo(() => {
    if (isLoading || workspaces.length === 0) return selectedWorkspaceId;
    const valid =
      selectedWorkspaceId &&
      workspaces.some((w) => w.id === selectedWorkspaceId);
    return valid ? selectedWorkspaceId : workspaces[0].id;
  }, [isLoading, workspaces, selectedWorkspaceId]);

  // Sync auto-selection to localStorage (external system side effect only)
  useEffect(() => {
    if (workspaceId && workspaceId !== selectedWorkspaceId) {
      localStorage.setItem(STORAGE_KEY, workspaceId);
    }
  }, [workspaceId, selectedWorkspaceId]);

  const setWorkspace = useCallback((id: string) => {
    localStorage.setItem(STORAGE_KEY, id);
    setSelectedWorkspaceId(id);
  }, []);

  const currentWorkspace = workspaces.find((w) => w.id === workspaceId);

  const value = useMemo(
    () => ({
      workspaceId,
      workspaceName: currentWorkspace?.name ?? null,
      workspaceRole: currentWorkspace?.role ?? null,
      workspaces,
      isLoading,
      setWorkspace,
    }),
    [
      workspaceId,
      currentWorkspace?.name,
      currentWorkspace?.role,
      workspaces,
      isLoading,
      setWorkspace,
    ]
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
