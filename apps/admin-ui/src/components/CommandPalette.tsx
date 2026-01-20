import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import {
  IconHome,
  IconSearch,
  IconFlask,
  IconUser,
  IconTimeline,
  IconTool,
  IconLayoutGrid,
  IconCpu,
  IconSend,
  IconRefresh,
  IconCopy,
  IconSettings,
  IconFolder,
} from "@tabler/icons-react";
import {
  colors,
  typography,
  spacing,
  shadows,
  borderRadius,
} from "../theme/tokens";
import { showInfoNotification } from "../lib/notifications";
import "./CommandPalette.css";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    if (open) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [open, onClose]);

  if (!open) return null;

  const handleNavigate = (path: string) => {
    navigate(path);
    onClose();
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <Command
        style={{
          backgroundColor: colors.background.primary,
          borderRadius: borderRadius.lg,
          maxWidth: "640px",
          width: "90%",
          boxShadow: shadows.xl,
          overflow: "hidden",
          border: `1px solid ${colors.border.default}`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            borderBottom: `1px solid ${colors.border.default}`,
            padding: `${spacing[3]} ${spacing[4]}`,
          }}
        >
          <IconSearch
            size={20}
            style={{ color: colors.text.tertiary, marginRight: spacing[2] }}
          />
          <Command.Input
            placeholder="Search for pages, actions, or paste an ID..."
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              backgroundColor: "transparent",
              fontFamily: typography.fontFamily.sans,
              fontSize: typography.fontSize.base,
              color: colors.text.primary,
            }}
          />
        </div>

        <Command.List
          style={{
            maxHeight: "400px",
            overflowY: "auto",
            padding: spacing[2],
          }}
        >
          <Command.Empty
            style={{
              padding: spacing[6],
              textAlign: "center",
              color: colors.text.secondary,
              fontSize: typography.fontSize.sm,
            }}
          >
            No results found.
          </Command.Empty>

          {/* Pages Section */}
          <Command.Group
            heading="Modules"
            style={{
              padding: spacing[2],
              fontSize: typography.fontSize.xs,
              fontWeight: typography.fontWeight.semibold,
              color: colors.text.tertiary,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            <CommandItem
              icon={<IconHome size={18} />}
              label="Health"
              description="System health & metrics dashboard"
              keywords={[
                "home",
                "main",
                "overview",
                "health",
                "metrics",
                "dashboard",
              ]}
              onSelect={() => handleNavigate("/")}
            />
            <CommandItem
              icon={<IconSearch size={18} />}
              label="Events"
              description="Event explorer & trace viewer"
              keywords={["events", "search", "trace", "investigate", "logs"]}
              onSelect={() => handleNavigate("/events")}
            />
            <CommandItem
              icon={<IconCpu size={18} />}
              label="Data"
              description="Database tables & vectors"
              keywords={["database", "tables", "data", "postgres", "vector"]}
              onSelect={() => handleNavigate("/data")}
            />
            <CommandItem
              icon={<IconFolder size={18} />}
              label="Files"
              description="Browse & manage files in storage"
              keywords={["files", "storage", "minio", "s3", "bucket", "upload"]}
              onSelect={() => handleNavigate("/files")}
            />
            <CommandItem
              icon={<IconTool size={18} />}
              label="Automation"
              description="Workers, webhooks & n8n"
              keywords={[
                "automation",
                "workers",
                "webhooks",
                "n8n",
                "subscribers",
              ]}
              onSelect={() => handleNavigate("/automation")}
            />
            <CommandItem
              icon={<IconLayoutGrid size={18} />}
              label="Architecture"
              description="Data Pod architecture overview"
              keywords={["architecture", "flow", "diagram", "overview"]}
              onSelect={() => handleNavigate("/flow")}
            />
            <CommandItem
              icon={<IconFlask size={18} />}
              label="Testing"
              description="Development & testing tools"
              keywords={["test", "playground", "ai", "tools", "publish"]}
              onSelect={() => handleNavigate("/testing")}
            />
          </Command.Group>

          {/* Quick Actions Section */}
          <Command.Group
            heading="Quick Actions"
            style={{
              padding: spacing[2],
              fontSize: typography.fontSize.xs,
              fontWeight: typography.fontWeight.semibold,
              color: colors.text.tertiary,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginTop: spacing[2],
            }}
          >
            <CommandItem
              icon={<IconUser size={18} />}
              label="Search Events"
              description="Search events by user or correlation ID"
              keywords={["user", "search", "filter"]}
              onSelect={() => handleNavigate("/events")}
            />
            <CommandItem
              icon={<IconTimeline size={18} />}
              label="View Event Trace"
              description="Trace an event and its correlations"
              keywords={["trace", "event", "correlation", "causation"]}
              onSelect={() => handleNavigate("/events")}
            />
            <CommandItem
              icon={<IconSend size={18} />}
              label="Publish Event"
              description="Manually publish a test event"
              keywords={["publish", "event", "send", "test"]}
              onSelect={() => handleNavigate("/testing")}
            />
            <CommandItem
              icon={<IconRefresh size={18} />}
              label="Refresh Data"
              description="Refresh all dashboard data"
              keywords={["refresh", "reload", "update"]}
              onSelect={() => {
                window.location.reload();
                showInfoNotification({ message: "Refreshing data..." });
              }}
            />
          </Command.Group>

          {/* System Actions Section */}
          <Command.Group
            heading="System"
            style={{
              padding: spacing[2],
              fontSize: typography.fontSize.xs,
              fontWeight: typography.fontWeight.semibold,
              color: colors.text.tertiary,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginTop: spacing[2],
            }}
          >
            <CommandItem
              icon={<IconCopy size={18} />}
              label="Copy Current URL"
              description="Copy the current page URL to clipboard"
              keywords={["copy", "url", "link", "share"]}
              onSelect={() => {
                navigator.clipboard.writeText(window.location.href);
                showInfoNotification({ message: "URL copied to clipboard" });
                onClose();
              }}
            />
            <CommandItem
              icon={<IconSettings size={18} />}
              label="View Automation"
              description="View webhooks and integrations"
              keywords={["automation", "webhooks", "n8n", "integrations"]}
              onSelect={() => handleNavigate("/automation")}
            />
          </Command.Group>
        </Command.List>

        {/* Footer with keyboard shortcuts */}
        <div
          style={{
            borderTop: `1px solid ${colors.border.default}`,
            padding: spacing[3],
            display: "flex",
            gap: spacing[4],
            fontSize: typography.fontSize.xs,
            color: colors.text.tertiary,
          }}
        >
          <div>
            <kbd style={kbdStyle}>↑↓</kbd> Navigate
          </div>
          <div>
            <kbd style={kbdStyle}>↵</kbd> Select
          </div>
          <div>
            <kbd style={kbdStyle}>Esc</kbd> Close
          </div>
        </div>
      </Command>
    </div>
  );
}

// CommandItem component
interface CommandItemProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  keywords: string[];
  onSelect: () => void;
}

function CommandItem({
  icon,
  label,
  description,
  keywords,
  onSelect,
}: CommandItemProps) {
  return (
    <Command.Item
      value={`${label} ${description} ${keywords.join(" ")}`}
      onSelect={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: spacing[3],
        padding: `${spacing[2]} ${spacing[3]}`,
        borderRadius: borderRadius.base,
        cursor: "pointer",
        userSelect: "none",
      }}
      // cmdk will apply [data-selected] attribute
    >
      <div style={{ color: colors.text.secondary, display: "flex" }}>
        {icon}
      </div>
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontFamily: typography.fontFamily.sans,
            fontSize: typography.fontSize.sm,
            fontWeight: typography.fontWeight.medium,
            color: colors.text.primary,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontFamily: typography.fontFamily.sans,
            fontSize: typography.fontSize.xs,
            color: colors.text.tertiary,
          }}
        >
          {description}
        </div>
      </div>
    </Command.Item>
  );
}

const kbdStyle: React.CSSProperties = {
  backgroundColor: colors.background.elevated,
  border: `1px solid ${colors.border.default}`,
  borderRadius: borderRadius.sm,
  padding: `2px ${spacing[1]}`,
  fontFamily: typography.fontFamily.mono,
  fontSize: typography.fontSize.xs,
  fontWeight: typography.fontWeight.medium,
  color: colors.text.secondary,
};
