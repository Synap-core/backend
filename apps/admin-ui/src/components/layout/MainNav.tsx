import { Link, useLocation } from "react-router-dom";
import { Button, cn, Separator } from "@heroui/react";
import {
  IconHome,
  IconSearch,
  IconKey,
  IconTerminal2,
  IconCheckbox,
  IconUsers,
  IconBuildingCommunity,
  IconPlug,
  IconPlugConnected,
  IconShieldLock,
  IconShieldCheck,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconFileText,
} from "@tabler/icons-react";
import { useWorkspace } from "../../lib/workspace";
import SearchCommandButton from "./SearchCommandButton";
import { NavListSectionBlock, type NavListSection } from "./NavList";

interface MainNavProps {
  onNavigate?: () => void;
  onCommandPaletteOpen?: () => void;
  /** Desktop icon rail; mobile drawer should omit this prop. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

const podSections: NavListSection[] = [
  {
    label: "Data pod",
    items: [
      { path: "/", label: "Pod overview", icon: IconHome },
      {
        path: "/pod-services",
        label: "Pod services",
        icon: IconPlugConnected,
      },
    ],
  },
  {
    label: "Data",
    items: [
      { path: "/documents", label: "Documents", icon: IconFileText },
      { path: "/events", label: "Events", icon: IconSearch },
      {
        path: "/workspaces",
        label: "Workspaces",
        icon: IconBuildingCommunity,
      },
      { path: "/users", label: "Users", icon: IconUsers },
    ],
  },
  {
    label: "External",
    items: [
      { path: "/external-sources", label: "External sources", icon: IconPlug },
    ],
  },
  {
    label: "Governance",
    items: [
      { path: "/secrets", label: "Secrets & keys", icon: IconShieldLock },
      {
        path: "/trusted-issuers",
        label: "Trusted issuers",
        icon: IconShieldCheck,
      },
    ],
  },
];

const workspaceSection: NavListSection = {
  label: "Workspace",
  items: [
    { path: "/workspace", label: "Workspace home", icon: IconHome },
    { path: "/proposals", label: "Proposals", icon: IconCheckbox },
    { path: "/intelligence", label: "Intelligence", icon: IconTerminal2 },
  ],
};

export default function MainNav({
  onNavigate,
  onCommandPaletteOpen,
  collapsed = false,
  onToggleCollapsed,
}: MainNavProps) {
  const location = useLocation();
  const { workspaceId, workspaceRole, workspaces, setWorkspace } =
    useWorkspace();

  const isAdmin = workspaceRole === "owner" || workspaceRole === "admin";
  const podNav = isAdmin
    ? podSections
    : podSections.map((s) => ({
        ...s,
        items: s.items.filter((i) => i.path !== "/users"),
      }));

  const isActive = (path: string) => {
    if (path === "/") {
      return location.pathname === "/";
    }
    if (path === "/workspaces") {
      return (
        location.pathname === "/workspaces" ||
        location.pathname.startsWith("/workspaces/")
      );
    }
    if (path === "/workspace") {
      return location.pathname === "/workspace";
    }
    return (
      location.pathname === path || location.pathname.startsWith(path + "/")
    );
  };

  return (
    <nav
      className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-linear-to-b from-[var(--admin-fluid-surface)] to-[var(--admin-fluid-surface-soft)] px-3 py-3"
      aria-label="Main navigation"
    >
      <div
        className={cn(
          "mb-4 flex shrink-0 flex-col gap-2",
          collapsed ? "items-center px-0" : "px-1"
        )}
      >
        <SearchCommandButton
          onPress={onCommandPaletteOpen}
          railOnly={collapsed}
        />
      </div>

      <Separator className="mb-4 shrink-0 opacity-60" />

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          collapsed
            ? "space-y-2"
            : "space-y-3 rounded-2xl border border-divider/70 bg-[var(--admin-fluid-surface)] p-2 shadow-sm"
        )}
      >
        {podNav.map((section) => (
          <div key={section.label}>
            <NavListSectionBlock
              section={section}
              collapsed={collapsed}
              isActive={isActive}
              onNavigate={onNavigate}
            />
          </div>
        ))}

        {isAdmin ? (
          <>
            <Separator className="my-2 opacity-60" />
            <div>
              {!collapsed && workspaces.length > 0 ? (
                <div className="mb-3 px-1">
                  <label
                    className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-default-400"
                    htmlFor="admin-workspace-select"
                  >
                    Active workspace
                  </label>
                  <select
                    id="admin-workspace-select"
                    className="w-full rounded-lg border border-divider bg-default-50 px-2 py-1.5 text-xs text-foreground outline-none transition-colors hover:border-default-300 focus:border-primary focus:ring-2 focus:ring-primary/20"
                    value={workspaceId ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v) setWorkspace(v);
                    }}
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <NavListSectionBlock
                section={workspaceSection}
                collapsed={collapsed}
                isActive={isActive}
                onNavigate={onNavigate}
              />
            </div>
          </>
        ) : null}
      </div>

      <div className="mt-auto shrink-0 space-y-2 border-t border-divider pt-3">
        {onToggleCollapsed ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "w-full rounded-xl text-default-500",
              collapsed
                ? "mx-auto h-9 w-9 min-w-0 rounded-2xl border border-divider bg-default-50 px-0 shadow-sm"
                : "justify-start"
            )}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            onPress={onToggleCollapsed}
          >
            {collapsed ? (
              <IconLayoutSidebarLeftExpand size={20} />
            ) : (
              <span className="inline-flex items-center gap-2">
                <IconLayoutSidebarLeftCollapse size={18} />
                <span className="text-xs">Collapse</span>
              </span>
            )}
          </Button>
        ) : null}

        {isAdmin ? (
          <Link
            to="/api-keys"
            onClick={onNavigate}
            title={collapsed ? "Hub API keys (full)" : undefined}
            className={cn(
              "group relative flex items-center text-sm text-default-600 transition-colors hover:bg-default-100/80 hover:text-foreground",
              collapsed
                ? "justify-center rounded-2xl p-2.5"
                : "gap-3 rounded-xl px-3 py-2.5",
              isActive("/api-keys")
                ? "bg-[var(--admin-fluid-selected)] font-semibold text-foreground shadow-sm"
                : undefined
            )}
          >
            {!collapsed && isActive("/api-keys") ? (
              <span
                className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-primary"
                aria-hidden
              />
            ) : null}
            <span
              className={cn(
                "flex shrink-0 items-center justify-center",
                collapsed ? "h-9 w-9 rounded-2xl" : "h-8 w-8 rounded-xl",
                isActive("/api-keys")
                  ? "bg-primary/16 text-primary"
                  : "bg-default-100 text-default-500 group-hover:bg-default-200 group-hover:text-default-700"
              )}
            >
              <IconKey size={collapsed ? 18 : 17} />
            </span>
            {collapsed ? (
              <span className="sr-only">Hub API keys (full)</span>
            ) : (
              <span className="truncate">Hub API keys (full)</span>
            )}
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
