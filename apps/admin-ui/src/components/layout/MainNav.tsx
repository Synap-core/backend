import { NavLink } from "@mantine/core";
import { Link, useLocation } from "react-router-dom";
import {
  IconHome,
  IconSearch,
  IconFlask,
  IconDatabase,
  IconWebhook,
  IconFolder,
  IconKey,
  IconTerminal2,
  IconCheckbox,
  IconUsers,
  IconBuildingCommunity,
  IconTopologyStarRing3,
  IconPlug,
} from "@tabler/icons-react";
import { useWorkspace } from "../../lib/workspace";
import { colors, layout, spacing, typography } from "../../theme/tokens";

interface MainNavProps {
  onNavigate?: () => void;
}

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const sections: NavSection[] = [
  {
    label: "Data Pod",
    items: [
      { path: "/", label: "Dashboard", icon: IconHome },
      { path: "/users", label: "Users", icon: IconUsers },
      { path: "/data", label: "Database", icon: IconDatabase },
      { path: "/files", label: "Files", icon: IconFolder },
      { path: "/events", label: "Events", icon: IconSearch },
      { path: "/api-keys", label: "API Keys", icon: IconKey },
    ],
  },
  {
    label: "Workspace",
    items: [
      { path: "/workspace", label: "Overview", icon: IconBuildingCommunity },
      { path: "/proposals", label: "Proposals", icon: IconCheckbox },
      { path: "/commands", label: "Intelligence", icon: IconTerminal2 },
      { path: "/services", label: "Services", icon: IconPlug },
    ],
  },
  {
    label: "Developer",
    items: [
      { path: "/testing", label: "Testing", icon: IconFlask },
      { path: "/automation", label: "Webhooks", icon: IconWebhook },
      { path: "/flow", label: "Architecture", icon: IconTopologyStarRing3 },
    ],
  },
];

export default function MainNav({ onNavigate }: MainNavProps) {
  const location = useLocation();
  const { workspaceRole } = useWorkspace();

  // Only show Data Pod section for owner/admin roles
  const isAdmin = workspaceRole === "owner" || workspaceRole === "admin";
  const visibleSections = isAdmin
    ? sections
    : sections.filter((s) => s.label !== "Data Pod");

  const isActive = (path: string) => {
    if (path === "/") {
      return location.pathname === "/" || location.pathname === "/health";
    }
    return (
      location.pathname === path || location.pathname.startsWith(path + "/")
    );
  };

  return (
    <nav
      style={{
        width: layout.navWidth,
        height: "100%",
        borderRight: `1px solid ${colors.border.default}`,
        backgroundColor: colors.background.primary,
        padding: `${spacing[3]} ${spacing[2]}`,
      }}
      aria-label="Main navigation"
    >
      {visibleSections.map((section, sectionIndex) => (
        <div key={section.label} style={{ marginBottom: spacing[4] }}>
          {/* Section label */}
          <div
            style={{
              fontSize: typography.fontSize.xs,
              fontWeight: typography.fontWeight.semibold,
              color: colors.text.tertiary,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              padding: `${spacing[1]} ${spacing[3]}`,
              marginBottom: spacing[1],
              marginTop: sectionIndex > 0 ? spacing[2] : 0,
            }}
          >
            {section.label}
          </div>

          {/* Section items */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: spacing[1],
            }}
          >
            {section.items.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);

              return (
                <NavLink
                  key={item.path}
                  component={Link}
                  to={item.path}
                  label={item.label}
                  leftSection={<Icon size={18} />}
                  active={active}
                  onClick={onNavigate}
                  style={{
                    borderRadius: "6px",
                    fontFamily: typography.fontFamily.sans,
                    fontSize: typography.fontSize.sm,
                    fontWeight: active
                      ? typography.fontWeight.semibold
                      : typography.fontWeight.normal,
                  }}
                  aria-label={item.label}
                />
              );
            })}
          </div>

          {/* Divider between sections */}
          {sectionIndex < visibleSections.length - 1 && (
            <div
              style={{
                height: "1px",
                backgroundColor: colors.border.light,
                margin: `${spacing[3]} ${spacing[2]} 0`,
              }}
            />
          )}
        </div>
      ))}
    </nav>
  );
}
