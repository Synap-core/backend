import { useState, useRef, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { cn } from "@heroui/react";
import {
  IconBuildingCommunity,
  IconChevronDown,
  IconCheck,
  IconLayoutGrid,
} from "@tabler/icons-react";
import { useWorkspace } from "../../lib/workspace";
import { pathScope } from "./nav-scope";

interface WorkspaceSwitcherProps {
  collapsed?: boolean;
}

export default function WorkspaceSwitcher({
  collapsed = false,
}: WorkspaceSwitcherProps) {
  const {
    workspaceId,
    workspaceName,
    workspaces,
    isAllWorkspaces,
    setWorkspace,
  } = useWorkspace();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const scope = pathScope(location.pathname);
  const isPodPage = scope === "pod";

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const label = isAllWorkspaces
    ? "All workspaces"
    : (workspaceName ?? "Unknown");
  const tooltip = isPodPage
    ? `Pod-wide page — selector applies to Lens pages.\nCurrent scope: ${label}`
    : undefined;

  if (collapsed) {
    return (
      <div ref={ref} className="relative">
        <button
          type="button"
          title={tooltip ?? label}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "relative mx-auto flex h-9 w-9 items-center justify-center rounded-xl border transition-colors",
            isPodPage
              ? "border-divider/50 bg-default-50 text-default-400 hover:bg-default-100"
              : "border-divider bg-default-100 text-default-500 hover:bg-default-200"
          )}
        >
          {isAllWorkspaces ? (
            <IconLayoutGrid size={16} />
          ) : (
            <IconBuildingCommunity size={16} />
          )}
        </button>
        {open && (
          <WorkspaceDropdown
            workspaces={workspaces}
            workspaceId={workspaceId}
            isAllWorkspaces={isAllWorkspaces}
            setWorkspace={setWorkspace}
            onClose={() => setOpen(false)}
            side="right"
            isPodPage={isPodPage}
          />
        )}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        title={tooltip}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-xs transition-colors",
          isPodPage
            ? "border-divider/50 bg-default-50 text-default-500 hover:bg-default-100"
            : "border-divider bg-default-100 text-foreground hover:bg-default-200",
          open && "border-primary/40 ring-2 ring-primary/15"
        )}
      >
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-md",
            isPodPage
              ? "bg-default-200 text-default-400"
              : isAllWorkspaces
                ? "bg-primary/10 text-primary"
                : "bg-secondary/10 text-secondary"
          )}
        >
          {isAllWorkspaces ? (
            <IconLayoutGrid size={12} />
          ) : (
            <IconBuildingCommunity size={12} />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn("truncate font-medium", isPodPage && "opacity-70")}
          >
            {label}
          </span>
          {isPodPage && (
            <span className="text-[9px] uppercase tracking-wide text-default-400">
              Pod-wide page
            </span>
          )}
        </div>
        <IconChevronDown
          size={13}
          className={cn(
            "shrink-0 text-default-400 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <WorkspaceDropdown
          workspaces={workspaces}
          workspaceId={workspaceId}
          isAllWorkspaces={isAllWorkspaces}
          setWorkspace={setWorkspace}
          onClose={() => setOpen(false)}
          side="bottom"
          isPodPage={isPodPage}
        />
      )}
    </div>
  );
}

function WorkspaceDropdown({
  workspaces,
  workspaceId,
  isAllWorkspaces,
  setWorkspace,
  onClose,
  side,
  isPodPage,
}: {
  workspaces: { id: string; name: string; type: string; memberCount: number }[];
  workspaceId: string | null;
  isAllWorkspaces: boolean;
  setWorkspace: (id: string | null) => void;
  onClose: () => void;
  side: "bottom" | "right";
  isPodPage: boolean;
}) {
  return (
    <div
      className={cn(
        "absolute z-50 min-w-[220px] overflow-hidden rounded-xl border border-divider bg-content1 py-1 shadow-lg",
        side === "bottom"
          ? "left-0 top-full mt-1 w-full"
          : "left-full top-0 ml-2"
      )}
    >
      {isPodPage && (
        <div className="border-b border-divider/60 px-3 py-2 text-[10px] leading-snug text-default-500">
          You're on a pod-wide page. Switching here changes the scope used on
          Lens pages (Events, Documents, Proposals, …).
        </div>
      )}

      {/* All workspaces option */}
      <button
        type="button"
        onClick={() => {
          setWorkspace(null);
          onClose();
        }}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-default-100",
          isAllWorkspaces && "bg-primary/5 text-primary"
        )}
      >
        <span className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-primary">
          <IconLayoutGrid size={11} />
        </span>
        <span className="flex-1 font-medium">All workspaces</span>
        {isAllWorkspaces && (
          <IconCheck size={13} className="shrink-0 text-primary" />
        )}
      </button>

      {workspaces.length > 0 && (
        <div className="my-1 mx-3 border-t border-divider/60" />
      )}

      <div className="max-h-56 overflow-y-auto">
        {workspaces.map((ws) => {
          const active = workspaceId === ws.id;
          return (
            <button
              key={ws.id}
              type="button"
              onClick={() => {
                setWorkspace(ws.id);
                onClose();
              }}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-default-100",
                active && "bg-secondary/5 text-secondary"
              )}
            >
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold uppercase",
                  active
                    ? "bg-secondary/15 text-secondary"
                    : "bg-default-200 text-default-500"
                )}
              >
                {ws.name.charAt(0)}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{ws.name}</span>
                <span className="text-[10px] text-default-400">
                  {ws.memberCount} member{ws.memberCount !== 1 ? "s" : ""}
                </span>
              </div>
              {active && (
                <IconCheck size={13} className="shrink-0 text-secondary" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
