"use client";

/**
 * Workspaces tab — list-only.
 *
 * The Pod Admin app intentionally does NOT render workspace internals
 * (members, profiles, settings). Studio owns those surfaces. This tab
 * therefore answers ONE question: "what workspaces live on this pod,
 * and how do I jump into one?"
 *
 * Layout:
 *   1. Header: title + stats chip cluster + Create button
 *   2. Single SectionCard with one row per workspace
 *   3. Click row → Drawer with read-only details + Open-in-Studio CTA
 *
 * Data source: `workspaces.adminListAll` (podAdmin only). Each row's
 * "Active / Idle / Archived" status is derived from `updatedAt` + a
 * `settings.archivedAt` hint when present.
 */

import {
  addToast,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Switch,
  Textarea,
  Tooltip,
  useDisclosure,
} from "@heroui/react";
import {
  ArchiveRestore,
  Building2,
  ExternalLink,
  MoreHorizontal,
  Plus,
  Settings2,
} from "lucide-react";
import { Suspense, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "../../../lib/trpc";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import { type StatusKind } from "../components/status-pill";
import {
  formatRelative,
  studioDeepLinkForWorkspace,
  studioDeepLinkForWorkspaceSettings,
} from "../people/_lib/helpers";

// Pull the workspace shape from the query response so we don't drift.
// We declare it inline (rather than using `inferRouterOutputs`) because
// the published `@synap-core/api-types` snapshot lags the live router and
// re-deriving via TypeScript indexing introduces brittle type plumbing.
type Workspace = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  /** From `WorkspaceSettings` in api-types — we only read a couple of
   *  optional keys, so a loose record is enough here. */
  settings: {
    archivedAt?: unknown;
    archived?: unknown;
    systemSlug?: unknown;
  } & Record<string, unknown>;
  ownerId: string;
  subscriptionTier: string | null;
  subscriptionStatus: string | null;
  stripeCustomerId: string | null;
  memberCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  /** Top-level archived flag (set by `workspaces.archive`). Older rows
   *  may only carry `settings.archivedAt`; we honour both. */
  archivedAt?: Date | string | null;
};

type WorkspaceStatus = {
  kind: StatusKind;
  label: "Active" | "Idle" | "Archived";
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function isArchived(ws: Workspace): boolean {
  if (ws.archivedAt) return true;
  const settings = (ws.settings ?? {}) as Record<string, unknown>;
  return Boolean(settings.archivedAt || settings.archived === true);
}

function deriveStatus(ws: Workspace): WorkspaceStatus {
  if (isArchived(ws)) {
    return { kind: "stale", label: "Archived" };
  }
  const updated =
    ws.updatedAt instanceof Date ? ws.updatedAt : new Date(ws.updatedAt);
  if (Date.now() - updated.getTime() < SEVEN_DAYS_MS) {
    return { kind: "healthy", label: "Active" };
  }
  return { kind: "unknown", label: "Idle" };
}

function workspaceInitial(ws: Workspace): string {
  const trimmed = (ws.name ?? "").trim();
  return trimmed.length > 0 ? trimmed[0].toUpperCase() : "?";
}

// Deterministic hue from workspace id so the chip color is stable.
function colorForWorkspace(ws: Workspace): string {
  let hash = 0;
  for (let i = 0; i < ws.id.length; i += 1) {
    hash = (hash + ws.id.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 45%)`;
}

// ─── Page ───────────────────────────────────────────────────────────

export default function WorkspacesPage() {
  // useSearchParams in `useFocusRow` requires a Suspense boundary in the
  // App Router; we wrap the heavy lifting in `WorkspacesInner`.
  return (
    <Suspense fallback={<WorkspacesFallback />}>
      <WorkspacesInner />
    </Suspense>
  );
}

function WorkspacesFallback() {
  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          Workspaces
        </h1>
      </header>
      <div className="h-9 w-full max-w-md rounded-md bg-foreground/[0.05] shimmer-pulse" />
    </div>
  );
}

function WorkspacesInner() {
  const router = useRouter();
  const createDisclosure = useDisclosure();
  const [showArchived, setShowArchived] = useState(false);

  // adminListAll is `void` input — server returns ALL workspaces
  // (including archived ones). We filter client-side based on the
  // toggle, treating any row with `archivedAt` (or legacy
  // `settings.archivedAt`/`settings.archived === true`) as archived.
  const query = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 30_000,
  });

  // The api-types snapshot types `settings` as the structured
  // WorkspaceSettings interface; we treat it as a loose record here so
  // we can read optional keys (`archivedAt`, `systemSlug`) without
  // cluttering the types with optional-everywhere chains.
  const allWorkspaces = (query.data ?? []) as unknown as Workspace[];
  const workspaces = useMemo(
    () =>
      showArchived
        ? allWorkspaces
        : allWorkspaces.filter((ws) => !isArchived(ws)),
    [allWorkspaces, showArchived]
  );

  const stats = useMemo(() => {
    let active = 0;
    for (const ws of allWorkspaces) {
      if (deriveStatus(ws).label === "Active") active += 1;
    }
    return { total: allWorkspaces.length, active };
  }, [allWorkspaces]);

  const archivedCount = useMemo(
    () => allWorkspaces.filter((ws) => isArchived(ws)).length,
    [allWorkspaces]
  );

  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
            Workspaces
          </h1>
          <p className="text-[13px] text-foreground/55">
            All workspaces on this pod. Internals are managed in Studio.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-md bg-foreground/[0.04] px-3 py-1.5 ring-1 ring-inset ring-foreground/10">
            <span className="text-[11.5px] tabular text-foreground/55">
              <span className="font-medium text-foreground">{stats.total}</span>{" "}
              total ·{" "}
              <span className="font-medium text-foreground">
                {stats.active}
              </span>{" "}
              active in last 7d
            </span>
          </div>
          <Button
            color="primary"
            variant="solid"
            radius="md"
            size="sm"
            startContent={<Plus className="h-3.5 w-3.5" />}
            onPress={createDisclosure.onOpen}
          >
            Create workspace
          </Button>
        </div>
      </header>

      <SectionCard
        title="All workspaces"
        hint="Click a row to view details"
        actions={
          archivedCount > 0 ? (
            <label className="flex items-center gap-2 text-[11.5px] text-foreground/55">
              <Switch
                size="sm"
                isSelected={showArchived}
                onValueChange={setShowArchived}
                aria-label="Show archived workspaces"
              />
              Show archived ({archivedCount})
            </label>
          ) : null
        }
      >
        {query.isLoading ? (
          <ResourceRowSkeleton count={4} />
        ) : query.isError ? (
          <ResourceRowError message="Couldn't load workspaces." />
        ) : workspaces.length === 0 ? (
          <ResourceRowEmpty message="No workspaces on this pod yet." />
        ) : (
          <div className="-mx-2">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                data-row-id={ws.id}
                className="rounded-md transition-shadow"
              >
                <WorkspaceRow
                  ws={ws}
                  onSelect={() => router.push(`/workspaces/${ws.id}`)}
                />
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <CreateWorkspaceModal
        isOpen={createDisclosure.isOpen}
        onClose={createDisclosure.onClose}
      />
    </div>
  );
}

// ─── Row ────────────────────────────────────────────────────────────

function WorkspaceRow({
  ws,
  onSelect,
}: {
  ws: Workspace;
  onSelect: () => void;
}) {
  const status = deriveStatus(ws);
  const settings = (ws.settings ?? {}) as Record<string, unknown>;
  const isSystem = typeof settings.systemSlug === "string";
  const archived = isArchived(ws);

  // The ResourceRow Icon slot is monochrome by design; we use a small
  // colored chip leading the primary text instead, rendered via the
  // primary string. Cleaner approach: keep the lucide Building2 icon
  // and overlay a colored dot via a second element — but ResourceRow
  // doesn't expose extra slots. Trade-off: we accept the monochrome
  // icon for now and let the status pill carry the color signal.
  return (
    <div className={archived ? "opacity-60" : undefined}>
      <ResourceRow
        Icon={Building2}
        primary={ws.name}
        secondary={[
          `${ws.memberCount} member${ws.memberCount === 1 ? "" : "s"}`,
          `created ${formatRelative(
            ws.createdAt instanceof Date ? ws.createdAt : new Date(ws.createdAt)
          )}`,
          ws.type,
        ].join(" · ")}
        status={status}
        onSelect={onSelect}
        actions={
          <WorkspaceRowActions
            ws={ws}
            isSystem={isSystem}
            archived={archived}
          />
        }
      />
    </div>
  );
}

function WorkspaceRowActions({
  ws,
  isSystem,
  archived,
}: {
  ws: Workspace;
  isSystem: boolean;
  archived: boolean;
}) {
  const utils = trpc.useUtils();
  const [confirmArchive, setConfirmArchive] = useState(false);

  const archiveMutation = trpc.workspaces.archive.useMutation({
    onSuccess: (_data, variables) => {
      void utils.workspaces.list.invalidate();
      void utils.workspaces.adminListAll.invalidate();
      addToast({
        title: variables.restore ? "Workspace restored" : "Workspace archived",
        description: variables.restore
          ? `${ws.name} is back in the active list.`
          : `${ws.name} is now archived.`,
        color: "default",
      });
      setConfirmArchive(false);
    },
    onError: (err) => {
      addToast({
        title: archived ? "Restore failed" : "Archive failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  return (
    <>
      <Popover placement="bottom-end">
        <PopoverTrigger>
          <Button
            isIconOnly
            variant="light"
            size="sm"
            radius="full"
            aria-label={`Actions for ${ws.name}`}
            className="text-foreground/40 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="min-w-[220px] max-w-[280px] p-1">
          <div className="flex w-full flex-col">
            <Button
              as="a"
              href={studioDeepLinkForWorkspace(ws.id)}
              target="_blank"
              rel="noopener noreferrer"
              variant="light"
              size="sm"
              radius="sm"
              className="justify-start text-[12.5px]"
              startContent={<ExternalLink className="h-3.5 w-3.5" />}
            >
              Open in Studio
            </Button>
            <Button
              as="a"
              href={studioDeepLinkForWorkspaceSettings(ws.id)}
              target="_blank"
              rel="noopener noreferrer"
              variant="light"
              size="sm"
              radius="sm"
              className="justify-start text-[12.5px]"
              startContent={<Settings2 className="h-3.5 w-3.5" />}
            >
              Settings in Studio
            </Button>
            {archived ? (
              <Button
                variant="light"
                size="sm"
                radius="sm"
                className="w-full justify-start text-[12.5px] text-success"
                startContent={<ArchiveRestore className="h-3.5 w-3.5" />}
                isDisabled={archiveMutation.isPending}
                onPress={() =>
                  archiveMutation.mutate({
                    workspaceId: ws.id,
                    restore: true,
                  })
                }
              >
                Restore
              </Button>
            ) : isSystem ? (
              <Tooltip content="System workspaces (e.g. pod-admin) can't be archived.">
                <span className="block">
                  <Button
                    variant="light"
                    size="sm"
                    radius="sm"
                    isDisabled
                    className="w-full justify-start text-[12.5px] text-warning"
                  >
                    Archive
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button
                variant="light"
                size="sm"
                radius="sm"
                className="w-full justify-start text-[12.5px] text-warning"
                onPress={() => setConfirmArchive(true)}
              >
                Archive
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {confirmArchive ? (
        <ConfirmArchiveWorkspaceModal
          workspaceName={ws.name}
          isPending={archiveMutation.isPending}
          onCancel={() => setConfirmArchive(false)}
          onConfirm={() => archiveMutation.mutate({ workspaceId: ws.id })}
        />
      ) : null}
    </>
  );
}

function ConfirmArchiveWorkspaceModal({
  workspaceName,
  isPending,
  onCancel,
  onConfirm,
}: {
  workspaceName: string;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose: onCancel,
  });

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1 border-b border-foreground/[0.06] px-6 py-4">
          <h2 className="text-[15px] font-medium text-foreground">
            Archive {workspaceName}?
          </h2>
        </ModalHeader>
        <ModalBody className="gap-2 px-6 py-4">
          <p className="text-[12.5px] text-foreground/85">
            Archived workspaces stay on the pod but are hidden from the default
            list. You can restore from the "Show archived" toggle.
          </p>
        </ModalBody>
        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button
            variant="flat"
            radius="md"
            size="sm"
            onPress={onCancel}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="warning"
            variant="solid"
            radius="md"
            size="sm"
            isLoading={isPending}
            onPress={onConfirm}
          >
            Archive workspace
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Create modal ───────────────────────────────────────────────────

function CreateWorkspaceModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const createMutation = trpc.workspaces.create.useMutation({
    onSuccess: () => {
      void utils.workspaces.adminListAll.invalidate();
      handleClose();
    },
    onError: (e) => setError(e.message),
  });

  function handleClose() {
    setName("");
    setDescription("");
    setError(null);
    onClose();
  }

  function handleSubmit() {
    setError(null);
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      type: "team",
    });
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      placement="center"
      size="md"
      backdrop="blur"
      isDismissable={!createMutation.isPending}
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1 border-b border-foreground/[0.06] px-6 py-4">
          <h2 className="text-[15px] font-medium text-foreground">
            Create workspace
          </h2>
          <p className="text-[12px] text-foreground/55">
            You'll be added as the owner. Use Studio to configure profiles and
            members.
          </p>
        </ModalHeader>
        <ModalBody className="gap-4 px-6 py-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="ws-name"
              className="text-[12px] font-medium text-foreground/70"
            >
              Name
            </label>
            <Input
              id="ws-name"
              placeholder="My Team"
              value={name}
              onValueChange={setName}
              radius="md"
              variant="flat"
              isDisabled={createMutation.isPending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="ws-desc"
              className="text-[12px] font-medium text-foreground/70"
            >
              Description (optional)
            </label>
            <Textarea
              id="ws-desc"
              placeholder="What's this space for?"
              value={description}
              onValueChange={setDescription}
              radius="md"
              variant="flat"
              minRows={3}
              isDisabled={createMutation.isPending}
            />
          </div>
          {error ? (
            <div className="rounded-md bg-status-down/10 px-3 py-2 text-[12px] text-status-down ring-1 ring-inset ring-status-down/20">
              {error}
            </div>
          ) : null}
        </ModalBody>
        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button
            variant="flat"
            radius="md"
            size="sm"
            onPress={handleClose}
            isDisabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            color="primary"
            variant="solid"
            radius="md"
            size="sm"
            onPress={handleSubmit}
            isDisabled={!name.trim() || createMutation.isPending}
            startContent={
              createMutation.isPending ? <Spinner size="sm" /> : null
            }
          >
            {createMutation.isPending ? "Creating…" : "Create"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
