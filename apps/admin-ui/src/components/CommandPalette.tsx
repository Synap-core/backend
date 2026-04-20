import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import {
  IconHome,
  IconSearch,
  IconCopy,
  IconRefresh,
  IconTimeline,
  IconUser,
  IconUsers,
  IconBuildingCommunity,
  IconCheckbox,
  IconKey,
  IconTerminal2,
  IconPlug,
  IconPlugConnected,
  IconShieldCheck,
  IconShieldLock,
  IconFileText,
  IconRobot,
} from "@tabler/icons-react";
import { Modal, Separator, Text, useOverlayState } from "@heroui/react";
import { showInfoNotification } from "../lib/notifications";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

interface CommandEntry {
  icon: React.ReactNode;
  label: string;
  description: string;
  keywords: string[];
  onSelect: () => void;
}

interface CommandSection {
  heading: string;
  entries: CommandEntry[];
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const state = useOverlayState({
    isOpen: open,
    onOpenChange: (next) => {
      if (!next) onClose();
    },
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        e.preventDefault();
        onClose();
      }
    };

    if (open) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const handleNavigate = (path: string) => {
    navigate(path);
    onClose();
  };

  const sections: CommandSection[] = [
    {
      heading: "Data & Search",
      entries: [
        {
          icon: <IconHome size={18} />,
          label: "Pod overview",
          description: "Pod health & activity",
          keywords: ["home", "overview", "health", "dashboard"],
          onSelect: () => handleNavigate("/"),
        },
        {
          icon: <IconFileText size={18} />,
          label: "Documents",
          description: "Pod-wide markdown and text files",
          keywords: ["documents", "markdown", "md", "notes", "files"],
          onSelect: () => handleNavigate("/documents"),
        },
        {
          icon: <IconSearch size={18} />,
          label: "Events",
          description: "Search and inspect the event log",
          keywords: ["events", "search", "trace", "investigate", "logs"],
          onSelect: () => handleNavigate("/events"),
        },
        {
          icon: <IconBuildingCommunity size={18} />,
          label: "Workspaces",
          description: "Workspaces and membership",
          keywords: ["workspaces", "spaces", "teams"],
          onSelect: () => handleNavigate("/workspaces"),
        },
        {
          icon: <IconUsers size={18} />,
          label: "Users",
          description: "Humans and agents on this pod",
          keywords: ["users", "people", "agents"],
          onSelect: () => handleNavigate("/users"),
        },
      ],
    },
    {
      heading: "Monitoring",
      entries: [
        {
          icon: <IconPlugConnected size={18} />,
          label: "Pod services",
          description: "Runtime health, logs, and runtime config",
          keywords: ["pod", "services", "runtime", "health", "docker", "logs"],
          onSelect: () => handleNavigate("/pod-services"),
        },
        {
          icon: <IconPlug size={18} />,
          label: "Integrations",
          description: "External systems, connectors, and advanced sources",
          keywords: ["connectors", "rss", "telegram", "sources", "external"],
          onSelect: () => handleNavigate("/connections"),
        },
        {
          icon: <IconRobot size={18} />,
          label: "Add-ons (OpenClaw)",
          description: "Manage OpenClaw lifecycle and troubleshooting",
          keywords: ["openclaw", "addon", "operations", "monitoring", "debug"],
          onSelect: () => handleNavigate("/openclaw"),
        },
      ],
    },
    {
      heading: "Governance",
      entries: [
        {
          icon: <IconShieldLock size={18} />,
          label: "Secrets",
          description: "Vault metadata and key inventories",
          keywords: ["secrets", "vault", "keys", "security"],
          onSelect: () => handleNavigate("/secrets"),
        },
        {
          icon: <IconKey size={18} />,
          label: "API keys",
          description: "Hub protocol keys and scopes",
          keywords: ["api", "keys", "token", "integration", "hub"],
          onSelect: () => handleNavigate("/api-keys"),
        },
        {
          icon: <IconShieldCheck size={18} />,
          label: "Trusted issuers",
          description: "Manage issuer approvals and trust",
          keywords: ["issuer", "trust", "security", "approval"],
          onSelect: () => handleNavigate("/trusted-issuers"),
        },
      ],
    },
    {
      heading: "Workspace",
      entries: [
        {
          icon: <IconHome size={18} />,
          label: "Workspace home",
          description: "Workspace dashboard for the selected workspace",
          keywords: ["workspace", "settings", "scope", "home"],
          onSelect: () => handleNavigate("/workspace"),
        },
        {
          icon: <IconCheckbox size={18} />,
          label: "Proposals",
          description: "Pending AI and sync proposals",
          keywords: ["proposals", "review", "governance"],
          onSelect: () => handleNavigate("/proposals"),
        },
        {
          icon: <IconTerminal2 size={18} />,
          label: "Intelligence",
          description: "Intelligence service connection",
          keywords: ["intelligence", "ai", "is", "hub"],
          onSelect: () => handleNavigate("/intelligence"),
        },
      ],
    },
    {
      heading: "Quick actions",
      entries: [
        {
          icon: <IconUser size={18} />,
          label: "Search events",
          description: "Search events by user or correlation ID",
          keywords: ["user", "search", "filter"],
          onSelect: () => handleNavigate("/events"),
        },
        {
          icon: <IconTimeline size={18} />,
          label: "View event trace",
          description: "Trace an event and its correlations",
          keywords: ["trace", "event", "correlation", "causation"],
          onSelect: () => handleNavigate("/events"),
        },
        {
          icon: <IconRefresh size={18} />,
          label: "Refresh data",
          description: "Reload the admin app",
          keywords: ["refresh", "reload", "update"],
          onSelect: () => {
            showInfoNotification({ message: "Refreshing…" });
            window.location.reload();
          },
        },
      ],
    },
    {
      heading: "System",
      entries: [
        {
          icon: <IconCopy size={18} />,
          label: "Copy current URL",
          description: "Copy this page’s address",
          keywords: ["copy", "url", "link", "share"],
          onSelect: () => {
            void navigator.clipboard.writeText(window.location.href);
            showInfoNotification({ message: "URL copied" });
            onClose();
          },
        },
      ],
    },
  ];

  if (!open) return null;

  return (
    <Modal state={state}>
      <Modal.Backdrop isDismissable>
        <Modal.Container size="lg" placement="center" scroll="inside">
          <Modal.Dialog>
            <Command className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-divider bg-content2 px-4 py-3 pr-12">
                <IconSearch size={18} className="shrink-0 text-default-400" />
                <Command.Input
                  ref={inputRef}
                  placeholder="Search pages, actions, or paste an ID…"
                  className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-default-400 focus-visible:ring-0"
                />
                <Modal.CloseTrigger className="absolute right-3 top-3 text-default-500 hover:text-foreground" />
              </div>

              <Command.List className="command-palette-list min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
                <Command.Empty className="px-4 py-8 text-center text-sm text-default-500">
                  No results found.
                </Command.Empty>

                {sections.map((section, index) => (
                  <div
                    key={section.heading}
                    className="command-palette-section"
                  >
                    {index > 0 ? (
                      <Separator className="my-2 opacity-60" />
                    ) : null}
                    <Command.Group
                      heading={section.heading}
                      className="command-palette-group px-2 py-1"
                    >
                      {section.entries.map((entry) => (
                        <CommandItem
                          key={`${section.heading}-${entry.label}`}
                          icon={entry.icon}
                          label={entry.label}
                          description={entry.description}
                          keywords={entry.keywords}
                          onSelect={entry.onSelect}
                        />
                      ))}
                    </Command.Group>
                  </div>
                ))}
              </Command.List>

              <div className="flex shrink-0 flex-wrap gap-4 border-t border-divider bg-content2 px-4 py-2.5">
                <div className="flex items-center gap-1.5 text-xs text-default-500">
                  <kbd className="rounded border border-divider bg-default-100 px-1.5 py-0.5 font-mono text-xs text-default-600">
                    ↑↓
                  </kbd>
                  <span>Navigate</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-default-500">
                  <kbd className="rounded border border-divider bg-default-100 px-1.5 py-0.5 font-mono text-xs text-default-600">
                    ↵
                  </kbd>
                  <span>Select</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-default-500">
                  <kbd className="rounded border border-divider bg-default-100 px-1.5 py-0.5 font-mono text-xs text-default-600">
                    Esc
                  </kbd>
                  <span>Close</span>
                </div>
              </div>
            </Command>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

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
      className="command-palette-item flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 text-left outline-none transition-all duration-200"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-default-100 text-default-500 shadow-sm">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <Text className="block text-sm font-medium text-foreground">
          {label}
        </Text>
        <Text className="block text-xs text-default-500">{description}</Text>
      </span>
    </Command.Item>
  );
}
