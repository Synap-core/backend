import { Link, useLocation } from "react-router-dom";
import { Button, cn, Separator, Text } from "@heroui/react";
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
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
} from "@tabler/icons-react";
import { useWorkspace } from "../../lib/workspace";
import BrandMark from "./BrandMark";
import SearchCommandButton from "./SearchCommandButton";

interface MainNavProps {
  onNavigate?: () => void;
  onCommandPaletteOpen?: () => void;
  /** Desktop icon rail; mobile drawer should omit this prop. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const podSections: NavSection[] = [
  {
    label: "Pod",
    items: [
      { path: "/", label: "Pod overview", icon: IconHome },
      {
        path: "/connections",
        label: "Connections & services",
        icon: IconPlugConnected,
      },
      { path: "/secrets", label: "Secrets & keys", icon: IconShieldLock },
      { path: "/users", label: "Users", icon: IconUsers },
      {
        path: "/workspaces",
        label: "Workspaces",
        icon: IconBuildingCommunity,
      },
      { path: "/events", label: "Events", icon: IconSearch },
    ],
  },
];

const workspaceSection: NavSection = {
  label: "Workspace",
  items: [
    { path: "/workspace", label: "Workspace home", icon: IconHome },
    { path: "/proposals", label: "Proposals", icon: IconCheckbox },
    { path: "/intelligence", label: "Intelligence", icon: IconTerminal2 },
    { path: "/services", label: "External agents", icon: IconPlug },
  ],
};

function NavLinkRow({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.path}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      className={cn(
        "group relative flex items-center rounded-lg text-sm transition-colors",
        collapsed ? "justify-center p-2.5" : "gap-3 px-2.5 py-2",
        active
          ? "bg-default-100 font-medium text-foreground"
          : "text-default-600 hover:bg-default-100/80 hover:text-foreground"
      )}
      aria-current={active ? "page" : undefined}
    >
      {!collapsed && active ? (
        <span
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary"
          aria-hidden
        />
      ) : null}
      <Icon
        size={collapsed ? 20 : 18}
        className={cn(
          "shrink-0 transition-colors",
          active
            ? "text-primary"
            : "text-default-400 group-hover:text-default-600"
        )}
        aria-hidden
      />
      {collapsed ? (
        <span className="sr-only">{item.label}</span>
      ) : (
        <span className="min-w-0 flex-1 truncate leading-snug">
          {item.label}
        </span>
      )}
    </Link>
  );
}

function SectionHeader({
  label,
  collapsed,
}: {
  label: string;
  collapsed: boolean;
}) {
  if (collapsed) {
    return null;
  }
  return (
    <div className="mb-1.5 px-0.5 pt-1">
      <Text className="text-[10px] font-semibold uppercase tracking-[0.12em] text-default-400">
        {label}
      </Text>
    </div>
  );
}

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
        items: s.items.filter(
          (i) => i.path !== "/users" && i.path !== "/connections"
        ),
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
      className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-background px-2 py-3"
      aria-label="Main navigation"
    >
      <div
        className={cn(
          "mb-3 flex shrink-0 flex-col gap-2",
          collapsed ? "items-center px-0" : "px-1"
        )}
      >
        <div className={cn(!collapsed ? "" : "flex justify-center")}>
          <BrandMark compact />
        </div>
        <SearchCommandButton
          onPress={onCommandPaletteOpen}
          railOnly={collapsed}
        />
      </div>

      <Separator className="mb-2 shrink-0" />

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {podNav.map((section) => (
          <div key={section.label}>
            <SectionHeader label={section.label} collapsed={collapsed} />
            <div
              className="flex flex-col gap-0.5"
              role="list"
              aria-label={section.label}
            >
              {section.items.map((item) => (
                <NavLinkRow
                  key={item.path}
                  item={item}
                  active={isActive(item.path)}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        ))}

        {isAdmin ? (
          <>
            <Separator className="my-2" />
            <div>
              {!collapsed && workspaces.length > 0 ? (
                <div className="mb-2 px-0.5">
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

              <SectionHeader
                label={workspaceSection.label}
                collapsed={collapsed}
              />
              <div
                className="flex flex-col gap-0.5"
                role="list"
                aria-label={workspaceSection.label}
              >
                {workspaceSection.items.map((item) => (
                  <NavLinkRow
                    key={item.path}
                    item={item}
                    active={isActive(item.path)}
                    collapsed={collapsed}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>

      <div className="mt-auto shrink-0 space-y-1 border-t border-divider pt-2">
        {onToggleCollapsed ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "w-full text-default-500",
              collapsed ? "min-w-0 px-0" : "justify-start"
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
              "group relative flex items-center rounded-lg text-sm text-default-600 transition-colors hover:bg-default-100/80 hover:text-foreground",
              collapsed ? "justify-center p-2.5" : "gap-3 px-2.5 py-2",
              isActive("/api-keys")
                ? "bg-default-100 font-medium text-foreground"
                : undefined
            )}
          >
            {!collapsed && isActive("/api-keys") ? (
              <span
                className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary"
                aria-hidden
              />
            ) : null}
            <IconKey
              size={collapsed ? 20 : 18}
              className={cn(
                "shrink-0",
                isActive("/api-keys")
                  ? "text-primary"
                  : "text-default-400 group-hover:text-default-600"
              )}
            />
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
