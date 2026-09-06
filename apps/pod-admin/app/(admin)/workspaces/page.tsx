"use client";

/**
 * Workspaces tab — the index over every workspace on this pod.
 *
 * This is the entry point, not the whole story: clicking a row opens
 * `/workspaces/[id]`, which pod-admin serves itself and which DOES render
 * workspace internals — Overview, Members, API keys, Connections and
 * Governance. (An earlier version of this comment claimed pod-admin
 * "intentionally does NOT render workspace internals" and that Studio owned
 * them. Both halves are false: the detail page has owned them for a while,
 * and Studio — the fluid web app — is deprecated.)
 *
 * So this page answers two questions: "what workspaces live on this pod?"
 * and "which one do I want to open?" Lifecycle verbs that only a pod admin
 * has (create, archive/restore, delete) live in the row's action menu.
 *
 * The one thing this page cannot do is show a workspace's *contents* —
 * the desktop app owns that. That exit is resolved by `openIn()`
 * (`lib/open-in.ts`) and, being a `synap://` link, always renders its
 * download fallback beside it.
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
  Trash2,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { ConfirmModal } from "../components/confirm-modal";
import { SectionCard } from "../components/section-card";
import { type StatusKind } from "../components/status-pill";
import { formatRelative } from "../people/_lib/helpers";
import { openIn } from "../../../lib/open-in";
import { ExitFallback } from "../../../lib/exit-link";

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

  // Expired session → login, not a dead "couldn't load" error.
  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error);
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

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
        {query.isLoading || isAuthRedirecting ? (
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
  const router = useRouter();
  const utils = trpc.useUtils();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const desktopExit = openIn({
    kind: "object",
    objectKind: "workspace",
    id: ws.id,
  });

  const deleteMutation = trpc.workspaces.adminDelete.useMutation({
    onSuccess: (data) => {
      void utils.workspaces.list.invalidate();
      void utils.workspaces.adminListAll.invalidate();
      const p = (data as { purged?: Record<string, number> }).purged;
      addToast({
        title: "Workspace permanently deleted",
        description: p
          ? `${ws.name}: removed ${p.entities} entities, ${p.relations} relations, ${p.proposals} proposals, ${p.documents} documents.`
          : `${ws.name} and its data were removed.`,
        color: "default",
      });
      setConfirmDelete(false);
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Delete failed",
        description: err.message,
        color: "danger",
      });
    },
  });

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
      if (redirectToLoginIfUnauthorized(err)) return;
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
            {/* The workspace's contents live in the desktop app. `synap://`
                does nothing at all when the app is not installed, so the
                download fallback is rendered right underneath — never a
                click with no way out. */}
            <Button
              as="a"
              href={desktopExit.href}
              variant="light"
              size="sm"
              radius="sm"
              className="justify-start text-[12.5px]"
              startContent={<ExternalLink className="h-3.5 w-3.5" />}
            >
              Open in the desktop app
            </Button>
            <span className="px-3 pb-1">
              <ExitFallback exit={desktopExit} />
            </span>
            {/* Members, API keys, connections and governance are pod-admin's
                own surfaces — internal navigation, not an exit. */}
            <Button
              variant="light"
              size="sm"
              radius="sm"
              className="justify-start text-[12.5px]"
              startContent={<Settings2 className="h-3.5 w-3.5" />}
              onPress={() => router.push(`/workspaces/${ws.id}`)}
            >
              Members, keys &amp; governance
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
            {!isSystem ? (
              <Button
                variant="light"
                size="sm"
                radius="sm"
                className="w-full justify-start text-[12.5px] text-danger"
                startContent={<Trash2 className="h-3.5 w-3.5" />}
                onPress={() => setConfirmDelete(true)}
              >
                Permanently delete
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      <ConfirmModal
        isOpen={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={() => archiveMutation.mutate({ workspaceId: ws.id })}
        title={`Archive ${ws.name}?`}
        consequence={
          <p>
            Archived workspaces stay on the pod but are hidden from the default
            list. Nothing inside is deleted, and you can restore from the "Show
            archived" toggle.
          </p>
        }
        confirmLabel="Archive workspace"
        /* Amber, not red: archive hides a workspace, it does not destroy one.
           Painting it destructive would say the opposite of the copy. */
        confirmColor="warning"
        isPending={archiveMutation.isPending}
      />

      <DeleteWorkspaceConfirm
        workspaceName={ws.name}
        isOpen={confirmDelete}
        isPending={deleteMutation.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          deleteMutation.mutate({
            workspaceId: ws.id,
            confirmName: ws.name,
          })
        }
      />
    </>
  );
}

/**
 * Workspace delete — `ConfirmModal` plus the one thing it deliberately does
 * not own: the type-the-name gate.
 *
 * The chrome, the pending behaviour and the tone all come from the shared
 * modal; this wrapper holds only the typed value and the match rule, and
 * clears it on close so a dismissed attempt never leaves the gate pre-cleared
 * for the next one.
 */
function DeleteWorkspaceConfirm({
  workspaceName,
  isOpen,
  isPending,
  onClose,
  onConfirm,
}: {
  workspaceName: string;
  isOpen: boolean;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === workspaceName;

  return (
    <ConfirmModal
      isOpen={isOpen}
      onClose={() => {
        setTyped("");
        onClose();
      }}
      onConfirm={onConfirm}
      title={`Permanently delete ${workspaceName}?`}
      consequence={
        <>
          <p>
            This <strong>cannot be undone</strong>. It removes the workspace and
            all of its workspace-scoped data — entities, relations, proposals,
            and documents (including stored files and search index). Pod-wide
            data shared with other workspaces is not affected.
          </p>
          <p className="mt-2">
            Type{" "}
            <span className="font-medium text-foreground">{workspaceName}</span>{" "}
            to confirm.
          </p>
        </>
      }
      confirmLabel="Delete permanently"
      isConfirmDisabled={!matches}
      isPending={isPending}
    >
      <Input
        size="sm"
        radius="md"
        value={typed}
        onValueChange={setTyped}
        placeholder={workspaceName}
        aria-label="Type the workspace name to confirm deletion"
        isDisabled={isPending}
      />
    </ConfirmModal>
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
    onError: (e) => {
      if (redirectToLoginIfUnauthorized(e)) return;
      setError(e.message);
    },
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
