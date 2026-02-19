import { NavLink } from "@mantine/core";
import { Link, useLocation } from "react-router-dom";
import {
  IconHome,
  IconSearch,
  IconFlask,
  IconHierarchy,
  IconDatabase,
  IconWebhook,
  IconFolder,
  IconBuildingCommunity,
  IconKey,
  IconTerminal2,
  IconBrain,
  IconCheckbox,
  IconMap,
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
    label: "Management",
    items: [
      { path: "/workspaces", label: "Workspaces", icon: IconBuildingCommunity },
      { path: "/api-keys", label: "API Keys", icon: IconKey },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { path: "/commands", label: "Commands", icon: IconTerminal2 },
      { path: "/memory", label: "Memory", icon: IconBrain },
      { path: "/proposals", label: "Proposals", icon: IconCheckbox },
    ],
  },
  {
    label: "System",
    items: [
      { path: "/", label: "Dashboard", icon: IconHome },
      { path: "/events", label: "Events", icon: IconSearch },
      { path: "/data", label: "Database", icon: IconDatabase },
      { path: "/files", label: "Files", icon: IconFolder },
      { path: "/automation", label: "Webhooks", icon: IconWebhook },
      { path: "/flow", label: "Architecture", icon: IconHierarchy },
      { path: "/testing", label: "Testing", icon: IconFlask },
    ],
  },
];

export default function MainNav({ onNavigate }: MainNavProps) {
  const location = useLocation();
  const { workspaceRole } = useWorkspace();

  // Only show Management section for owner/admin roles
  const isAdmin = workspaceRole === "owner" || workspaceRole === "admin";
  const visibleSections = isAdmin
    ? sections
    : sections.filter((s) => s.label !== "Management");

  const isActive = (path: string) => {
    if (path === "/") {
      return location.pathname === "/" || location.pathname === "/health";
    }
    return location.pathname === path || location.pathname.startsWith(path + "/");
  };

  return (
    <nav
      style={{
        width: layout.navWidth,
        height: `calc(100vh - ${layout.topBarHeight})`,
        borderRight: `1px solid ${colors.border.default}`,
        backgroundColor: colors.background.primary,
        padding: `${spacing[3]} ${spacing[2]}`,
        position: "sticky",
        top: layout.topBarHeight,
        overflowY: "auto",
        flexShrink: 0,
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
          <div style={{ display: "flex", flexDirection: "column", gap: spacing[1] }}>
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
