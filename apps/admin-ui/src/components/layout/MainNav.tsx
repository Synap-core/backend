import { useLocation } from "react-router-dom";
import { Button, cn, Separator } from "@heroui/react";
import {
  IconHome,
  IconSearch,
  IconTerminal2,
  IconCheckbox,
  IconUsers,
  IconBuildingCommunity,
  IconPlug,
  IconPlugConnected,
  IconShieldLock,
  IconShieldCheck,
  IconRobot,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconFileText,
  IconMoon,
  IconSun,
} from "@tabler/icons-react";
import { useWorkspace } from "../../lib/workspace";
import { useThemeContext } from "../../main";
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
    label: "Overview",
    items: [{ path: "/", label: "Pod overview", icon: IconHome }],
  },
  {
    label: "Data & search",
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
    label: "Monitoring",
    items: [
      {
        path: "/pod-services",
        label: "Pod services",
        icon: IconPlugConnected,
      },
      {
        path: "/connections",
        label: "Integrations",
        icon: IconPlug,
      },
      { path: "/openclaw", label: "Add-ons (OpenClaw)", icon: IconRobot },
    ],
  },
  {
    label: "Governance",
    items: [
      { path: "/secrets", label: "Secrets & keys", icon: IconShieldLock },
      { path: "/api-keys", label: "API keys", icon: IconShieldLock },
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
  const { theme, toggleTheme } = useThemeContext();

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
      className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-content2 px-3 py-3"
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
            : "space-y-3 rounded-2xl border border-divider/70 bg-content1 p-2 shadow-sm"
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
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "w-full rounded-xl text-default-500",
            collapsed
              ? "mx-auto h-9 w-9 min-w-0 rounded-2xl border border-divider bg-default-50 px-0 shadow-sm"
              : "justify-start"
          )}
          aria-label={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
          onPress={toggleTheme}
        >
          {collapsed ? (
            theme === "dark" ? (
              <IconSun size={20} />
            ) : (
              <IconMoon size={20} />
            )
          ) : (
            <span className="inline-flex items-center gap-2">
              {theme === "dark" ? (
                <>
                  <IconSun size={18} />
                  <span className="text-xs">Light mode</span>
                </>
              ) : (
                <>
                  <IconMoon size={18} />
                  <span className="text-xs">Dark mode</span>
                </>
              )}
            </span>
          )}
        </Button>

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

        {/* Footer intentionally reserved for layout controls only. */}
      </div>
    </nav>
  );
}
