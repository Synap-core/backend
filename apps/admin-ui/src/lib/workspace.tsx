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
const ALL_VALUE = "__all__";

interface Workspace {
  id: string;
  name: string;
  type: string;
  memberCount: number;
}

interface WorkspaceState {
  /** null = "All workspaces" (pod-wide view) */
  workspaceId: string | null;
  workspaceName: string | null;
  workspaces: Workspace[];
  isLoading: boolean;
  isAllWorkspaces: boolean;
  setWorkspace: (id: string | null) => void;
}

const WorkspaceContext = createContext<WorkspaceState>({
  workspaceId: null,
  workspaceName: null,
  workspaces: [],
  isLoading: true,
  isAllWorkspaces: true,
  setWorkspace: () => {},
});

export function useWorkspace(): WorkspaceState {
  return useContext(WorkspaceContext);
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [rawStored, setRawStored] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  // Use adminListAll so the selector shows every workspace on the pod,
  // not only ones the admin user is a direct member of.
  const { data: workspacesRaw, isLoading } =
    trpc.workspaces.adminListAll.useQuery();

  const workspaces: Workspace[] = useMemo(
    () =>
      (workspacesRaw ?? []).map((w) => ({
        id: w.id,
        name: w.name,
        type: w.type,
        memberCount: w.memberCount,
      })),
    [workspacesRaw]
  );

  // null   → "All workspaces" (default)
  // string → specific workspace ID
  const workspaceId = useMemo(() => {
    if (!rawStored || rawStored === ALL_VALUE) return null;
    // Validate the stored ID is still a real workspace
    if (isLoading) return null;
    const valid = workspaces.some((w) => w.id === rawStored);
    return valid ? rawStored : null;
  }, [rawStored, workspaces, isLoading]);

  const setWorkspace = useCallback((id: string | null) => {
    const val = id ?? ALL_VALUE;
    try {
      localStorage.setItem(STORAGE_KEY, val);
    } catch {
      /* ignore */
    }
    setRawStored(val);
  }, []);

  const currentWorkspace = workspaces.find((w) => w.id === workspaceId);

  const value = useMemo(
    () => ({
      workspaceId,
      workspaceName: currentWorkspace?.name ?? null,
      workspaces,
      isLoading,
      isAllWorkspaces: workspaceId === null,
      setWorkspace,
    }),
    [workspaceId, currentWorkspace?.name, workspaces, isLoading, setWorkspace]
  );

  // Keep the X-Workspace-Id header in sync (used by tRPC client).
  // When null, remove it so workspace-scoped endpoints see no workspace.
  useEffect(() => {
    if (workspaceId) {
      localStorage.setItem("synap_workspace_id", workspaceId);
    } else {
      localStorage.removeItem("synap_workspace_id");
    }
  }, [workspaceId]);

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
