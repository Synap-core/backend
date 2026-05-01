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
  IconDatabase,
  IconListDetails,
  IconMoon,
  IconSun,
} from "@tabler/icons-react";
import { useThemeContext } from "../../main";
import SearchCommandButton from "./SearchCommandButton";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import { NavListSectionBlock, type NavListSection } from "./NavList";

interface MainNavProps {
  onNavigate?: () => void;
  onCommandPaletteOpen?: () => void;
  /** Desktop icon rail; mobile drawer should omit this prop. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/**
 * Two top-level sections, mirroring the conceptual split:
 *  - Pod  → infra, sovereignty, inventory. Workspace selector doesn't apply.
 *  - Lens → workspace-aware data. Selector filters; "All" shows aggregate.
 *
 * If you add a new route, also register it in `nav-scope.ts` so the
 * WorkspaceSwitcher knows whether to mute itself on that page.
 */
const podSection: NavListSection = {
  label: "Pod",
  items: [
    { path: "/", label: "Pod overview", icon: IconHome },
    { path: "/pod-services", label: "Pod services", icon: IconPlugConnected },
    { path: "/jobs", label: "Jobs", icon: IconListDetails },
    { path: "/workspaces", label: "Workspaces", icon: IconBuildingCommunity },
    { path: "/users", label: "Users", icon: IconUsers },
    {
      path: "/trusted-issuers",
      label: "Trusted issuers",
      icon: IconShieldCheck,
    },
    { path: "/secrets", label: "Secrets", icon: IconShieldLock },
    { path: "/openclaw", label: "Add-ons", icon: IconRobot },
    {
      path: "/intelligence",
      label: "Intelligence services",
      icon: IconTerminal2,
    },
  ],
};

const lensSection: NavListSection = {
  label: "Lens",
  items: [
    { path: "/workspace", label: "Workspace home", icon: IconHome },
    { path: "/events", label: "Events", icon: IconSearch },
    { path: "/entities", label: "Entities", icon: IconDatabase },
    { path: "/documents", label: "Documents", icon: IconFileText },
    { path: "/proposals", label: "Proposals", icon: IconCheckbox },
    { path: "/connections", label: "Connections", icon: IconPlug },
    { path: "/api-keys", label: "API keys", icon: IconShieldLock },
  ],
};

export default function MainNav({
  onNavigate,
  onCommandPaletteOpen,
  collapsed = false,
  onToggleCollapsed,
}: MainNavProps) {
  const location = useLocation();
  const { theme, toggleTheme } = useThemeContext();

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
          "mb-3 flex shrink-0 flex-col gap-2",
          collapsed ? "items-center px-0" : "px-1"
        )}
      >
        <WorkspaceSwitcher collapsed={collapsed} />
        <SearchCommandButton
          onPress={onCommandPaletteOpen}
          railOnly={collapsed}
        />
      </div>

      <Separator className="mb-3 shrink-0 opacity-60" />

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          collapsed
            ? "space-y-2"
            : "space-y-3 rounded-2xl border border-divider/70 bg-content1 p-2 shadow-sm"
        )}
      >
        <NavListSectionBlock
          section={podSection}
          collapsed={collapsed}
          isActive={isActive}
          onNavigate={onNavigate}
        />
        <Separator className="my-2 opacity-60" />
        <NavListSectionBlock
          section={lensSection}
          collapsed={collapsed}
          isActive={isActive}
          onNavigate={onNavigate}
        />
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
