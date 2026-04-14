import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import {
  IconHome,
  IconSearch,
  IconUser,
  IconTimeline,
  IconRefresh,
  IconCopy,
  IconUsers,
  IconBuildingCommunity,
  IconKey,
  IconCheckbox,
  IconTerminal2,
  IconPlug,
  IconPlugConnected,
  IconShieldLock,
  IconFileText,
} from "@tabler/icons-react";
import { Modal, Text, useOverlayState } from "@heroui/react";
import { showInfoNotification } from "../lib/notifications";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();

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

  const handleNavigate = (path: string) => {
    navigate(path);
    onClose();
  };

  return (
    <Modal state={state}>
      <Modal.Backdrop isDismissable className="bg-black/50 backdrop-blur-sm" />
      <Modal.Container
        size="lg"
        placement="top"
        scroll="inside"
        className="pt-[min(12vh,120px)]"
      >
        <Modal.Dialog className="relative flex max-h-[min(640px,85vh)] flex-col overflow-hidden border border-divider bg-content1 text-foreground shadow-xl">
          <Command className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-divider px-4 py-3 pr-12">
              <IconSearch size={18} className="shrink-0 text-default-400" />
              <Command.Input
                placeholder="Search pages, actions, or paste an ID…"
                className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-default-400 focus-visible:ring-0"
              />
              <Modal.CloseTrigger className="absolute right-3 top-3 text-default-500 hover:text-foreground" />
            </div>

            <Command.List className="command-palette-list min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-2">
              <Command.Empty className="px-4 py-8 text-center text-sm text-default-500">
                No results found.
              </Command.Empty>

              <Command.Group
                heading="Modules"
                className="command-palette-group px-2 py-1"
              >
                <CommandItem
                  icon={<IconHome size={18} />}
                  label="Pod overview"
                  description="Pod health & activity"
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
                  icon={<IconPlugConnected size={18} />}
                  label="Connections & services"
                  description="Integrations, feeds, intelligence, infra checks"
                  keywords={[
                    "connections",
                    "integrations",
                    "rss",
                    "telegram",
                    "services",
                    "health",
                  ]}
                  onSelect={() => handleNavigate("/connections")}
                />
                <CommandItem
                  icon={<IconShieldLock size={18} />}
                  label="Secrets & keys"
                  description="API keys overview and vault metadata"
                  keywords={["secrets", "vault", "keys", "security"]}
                  onSelect={() => handleNavigate("/secrets")}
                />
                <CommandItem
                  icon={<IconUsers size={18} />}
                  label="Users"
                  description="Humans and agents on this pod"
                  keywords={["users", "people", "agents"]}
                  onSelect={() => handleNavigate("/users")}
                />
                <CommandItem
                  icon={<IconBuildingCommunity size={18} />}
                  label="Workspaces"
                  description="Workspaces and membership"
                  keywords={["workspaces", "spaces", "teams"]}
                  onSelect={() => handleNavigate("/workspaces")}
                />
                <CommandItem
                  icon={<IconFileText size={18} />}
                  label="Documents"
                  description="Markdown and text files in the active workspace"
                  keywords={["documents", "markdown", "md", "notes", "files"]}
                  onSelect={() => handleNavigate("/documents")}
                />
                <CommandItem
                  icon={<IconSearch size={18} />}
                  label="Events"
                  description="Search and inspect the event log"
                  keywords={[
                    "events",
                    "search",
                    "trace",
                    "investigate",
                    "logs",
                  ]}
                  onSelect={() => handleNavigate("/events")}
                />
                <CommandItem
                  icon={<IconKey size={18} />}
                  label="API keys"
                  description="Hub protocol keys and scopes"
                  keywords={["api", "keys", "token", "integration", "hub"]}
                  onSelect={() => handleNavigate("/api-keys")}
                />
                <CommandItem
                  icon={<IconHome size={18} />}
                  label="Workspace home"
                  description="Workspace dashboard for the selected workspace"
                  keywords={["workspace", "settings", "scope", "home"]}
                  onSelect={() => handleNavigate("/workspace")}
                />
                <CommandItem
                  icon={<IconCheckbox size={18} />}
                  label="Proposals"
                  description="Pending AI and sync proposals"
                  keywords={["proposals", "review", "governance"]}
                  onSelect={() => handleNavigate("/proposals")}
                />
                <CommandItem
                  icon={<IconTerminal2 size={18} />}
                  label="Intelligence"
                  description="Intelligence service connection"
                  keywords={["intelligence", "ai", "is", "hub"]}
                  onSelect={() => handleNavigate("/intelligence")}
                />
                <CommandItem
                  icon={<IconPlug size={18} />}
                  label="External agents"
                  description="Provision OpenClaw / ZeroClaw for this workspace"
                  keywords={["services", "openclaw", "zeroclaw", "agents"]}
                  onSelect={() => handleNavigate("/services")}
                />
              </Command.Group>

              <Command.Group
                heading="Quick actions"
                className="command-palette-group px-2 py-1"
              >
                <CommandItem
                  icon={<IconUser size={18} />}
                  label="Search events"
                  description="Search events by user or correlation ID"
                  keywords={["user", "search", "filter"]}
                  onSelect={() => handleNavigate("/events")}
                />
                <CommandItem
                  icon={<IconTimeline size={18} />}
                  label="View event trace"
                  description="Trace an event and its correlations"
                  keywords={["trace", "event", "correlation", "causation"]}
                  onSelect={() => handleNavigate("/events")}
                />
                <CommandItem
                  icon={<IconRefresh size={18} />}
                  label="Refresh data"
                  description="Reload the admin app"
                  keywords={["refresh", "reload", "update"]}
                  onSelect={() => {
                    showInfoNotification({ message: "Refreshing…" });
                    window.location.reload();
                  }}
                />
              </Command.Group>

              <Command.Group
                heading="System"
                className="command-palette-group px-2 py-1"
              >
                <CommandItem
                  icon={<IconCopy size={18} />}
                  label="Copy current URL"
                  description="Copy this page’s address"
                  keywords={["copy", "url", "link", "share"]}
                  onSelect={() => {
                    void navigator.clipboard.writeText(window.location.href);
                    showInfoNotification({ message: "URL copied" });
                    onClose();
                  }}
                />
              </Command.Group>
            </Command.List>

            <div className="flex shrink-0 flex-wrap gap-4 border-t border-divider px-4 py-2">
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
      className="command-palette-item flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors data-[selected=true]:bg-default-100"
    >
      <span className="flex shrink-0 text-default-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <Text className="block text-sm font-medium text-foreground">
          {label}
        </Text>
        <Text className="block text-xs text-default-500">{description}</Text>
      </span>
    </Command.Item>
  );
}
