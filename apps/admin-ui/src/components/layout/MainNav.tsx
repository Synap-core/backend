import { Link, useLocation } from "react-router-dom";
import {
  IconHome,
  IconSearch,
  IconKey,
  IconTerminal2,
  IconCheckbox,
  IconUsers,
  IconBuildingCommunity,
  IconPlug,
} from "@tabler/icons-react";
import { cn } from "@heroui/react";
import { useWorkspace } from "../../lib/workspace";
import { layout, spacing } from "../../theme/tokens";

interface MainNavProps {
  onNavigate?: () => void;
}

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

interface NavSection {
  label: string;
  hint?: string;
  items: NavItem[];
}

const sections: NavSection[] = [
  {
    label: "Home",
    hint: "Your server at a glance",
    items: [{ path: "/", label: "Overview", icon: IconHome }],
  },
  {
    label: "Operate",
    hint: "Pod-wide: people, spaces, and audit trail",
    items: [
      { path: "/users", label: "Users", icon: IconUsers },
      { path: "/workspaces", label: "Workspaces", icon: IconBuildingCommunity },
      { path: "/events", label: "Events", icon: IconSearch },
    ],
  },
  {
    label: "Connect",
    hint: "API keys and integrations",
    items: [{ path: "/api-keys", label: "API keys", icon: IconKey }],
  },
  {
    label: "Workspace",
    hint: "Scoped to the workspace below — full editing lives in Synap Browser.",
    items: [
      { path: "/workspace", label: "Overview", icon: IconHome },
      { path: "/proposals", label: "Proposals", icon: IconCheckbox },
      { path: "/intelligence", label: "Intelligence", icon: IconTerminal2 },
      { path: "/services", label: "Services", icon: IconPlug },
    ],
  },
];

function NavLinkRow({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.path}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2 rounded-medium px-3 py-2 text-small transition-colors",
        active
          ? "bg-primary/15 font-semibold text-primary"
          : "text-default-600 hover:bg-default-100"
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={18} className="shrink-0 opacity-80" />
      {item.label}
    </Link>
  );
}

export default function MainNav({ onNavigate }: MainNavProps) {
  const location = useLocation();
  const { workspaceId, workspaceRole, workspaces, setWorkspace } =
    useWorkspace();

  const isAdmin = workspaceRole === "owner" || workspaceRole === "admin";
  const visibleSections = isAdmin
    ? sections
    : sections.filter((s) => s.label !== "Operate" && s.label !== "Connect");

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
      className="h-full overflow-y-auto border-r border-divider bg-background p-3"
      style={{ width: layout.navWidth }}
      aria-label="Main navigation"
    >
      {visibleSections.map((section, sectionIndex) => (
        <div
          key={section.label}
          className="mb-4"
          style={{ marginBottom: spacing[4] }}
        >
          {section.label === "Workspace" && workspaces.length > 0 ? (
            <div className="mb-3 px-1">
              <label
                className="mb-1 block text-xs font-medium uppercase tracking-wide text-default-400"
                htmlFor="admin-workspace-select"
              >
                Active workspace
              </label>
              <select
                id="admin-workspace-select"
                className="w-full rounded-medium border border-divider bg-default-100 px-2 py-1.5 text-xs text-default-700 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
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
              {section.hint ? (
                <p className="mt-2 text-[11px] leading-snug text-default-400">
                  {section.hint}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="mb-1 px-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-default-400">
              {section.label}
            </div>
            {section.hint && section.label !== "Workspace" ? (
              <p className="mt-1 text-[11px] leading-snug text-default-400">
                {section.hint}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <NavLinkRow
                key={item.path}
                item={item}
                active={isActive(item.path)}
                onNavigate={onNavigate}
              />
            ))}
          </div>

          {sectionIndex < visibleSections.length - 1 ? (
            <div
              className="mx-2 mt-3 h-px bg-divider"
              style={{ marginTop: spacing[3] }}
            />
          ) : null}
        </div>
      ))}
    </nav>
  );
}
