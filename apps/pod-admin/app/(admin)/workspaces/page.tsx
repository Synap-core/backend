"use client";

/**
 * Spaces — the index over every space (workspace) on this pod.
 *
 * Clicking a row opens `/workspaces/[id]`, which pod-admin serves itself:
 * Overview, Members, API keys, Connections and Governance. This page answers
 * "what spaces live on this pod?" and "which one do I want to open?".
 * Lifecycle verbs that only a pod admin has (create, archive/restore,
 * delete) live in the row's action menu.
 *
 * It cannot show a space's *contents* — the app owns that. The exit is
 * resolved by `openIn()` (`lib/open-in.ts`) and, being a `synap://` link,
 * always renders its download fallback beside it.
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
  ArrowUpRight,
  MoreHorizontal,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import { navLabel } from "../../../lib/console-nav";
import { useFocusRow } from "../components/use-focus-row";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { ConfirmModal } from "../components/confirm-modal";
import { SectionCard } from "../components/section-card";
import { type StatusKind } from "../components/status-pill";
import { formatRelative, readableError } from "../../../lib/format";
import { openIn } from "../../../lib/open-in";
import { ExitFallback, usePlacedExit } from "../../../lib/exit-link";

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
  // `useFocusRow` (in `WorkspacesInner`) reads useSearchParams, which needs a
  // Suspense boundary in the App Router.
  return (
    <Suspense fallback={<PageFallback />}>
      <WorkspacesInner />
    </Suspense>
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

  // Receives `?focus=<id>` from the search palette; rows carry `data-row-id`.
  useFocusRow({ ready: !query.isLoading });

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
    <PageShell>
      <PageHeader
        title={navLabel("spaces")}
        description="All spaces on this pod. What is inside them is edited in the app."
        actions={
          <>
            <div className="flex items-center gap-2 rounded-md bg-foreground/[0.04] px-3 py-1.5 ring-1 ring-inset ring-foreground/10">
              <span className="text-[11.5px] tabular text-foreground/65">
                <span className="font-medium text-foreground">
                  {stats.total}
                </span>{" "}
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
              Create space
            </Button>
          </>
        }
      />

      <SectionCard
        title="All spaces"
        hint="Click a row to view details"
        actions={
          archivedCount > 0 ? (
            <label className="flex items-center gap-2 text-[11.5px] text-foreground/65">
              <Switch
                size="sm"
                isSelected={showArchived}
                onValueChange={setShowArchived}
                aria-label="Show archived spaces"
              />
              Show archived ({archivedCount})
            </label>
          ) : null
        }
      >
        {query.isLoading || isAuthRedirecting ? (
          <ResourceRowSkeleton count={4} />
        ) : query.isError ? (
          <ResourceRowError message="Couldn't load spaces." />
        ) : workspaces.length === 0 ? (
          <ResourceRowEmpty message="No spaces on this pod yet." />
        ) : (
          <div className="-mx-2 divide-y divide-foreground/[0.05]">
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
    </PageShell>
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
  // `null` on a phone: the mobile app has no space screen. The line beneath
  // says so and links this space's own page instead.
  const appHref = usePlacedExit(desktopExit).href;

  const deleteMutation = trpc.workspaces.adminDelete.useMutation({
    onSuccess: (data) => {
      void utils.workspaces.list.invalidate();
      void utils.workspaces.adminListAll.invalidate();
      const p = (data as { purged?: Record<string, number> }).purged;
      addToast({
        title: "Space permanently deleted",
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
        title: "Couldn't delete the space",
        description: readableError(err.message),
        color: "danger",
      });
    },
  });

  const archiveMutation = trpc.workspaces.archive.useMutation({
    onSuccess: (_data, variables) => {
      void utils.workspaces.list.invalidate();
      void utils.workspaces.adminListAll.invalidate();
      addToast({
        title: variables.restore ? "Space restored" : "Space archived",
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
        title: archived
          ? "Couldn't restore the space"
          : "Couldn't archive the space",
        description: readableError(err.message),
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
            className="text-foreground/65 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[pressed=true]:opacity-100 [@media(hover:none)]:opacity-100"
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
            {appHref !== null && (
              <Button
                as="a"
                href={appHref}
                variant="light"
                size="sm"
                radius="sm"
                className="justify-start text-[12.5px]"
                startContent={
                  <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                }
              >
                Open in app
              </Button>
            )}
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
              <Tooltip content="System spaces (e.g. pod-admin) can't be archived.">
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
            Archived spaces stay on the pod but are hidden from the default
            list. Nothing inside is deleted, and you can restore from the "Show
            archived" toggle.
          </p>
        }
        confirmLabel="Archive space"
        /* Amber, not red: archive hides a space, it does not destroy one.
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
            This <strong>cannot be undone</strong>. It removes the space and all
            of its space-scoped data — entities, relations, proposals, and
            documents (including stored files and search index). Pod-wide data
            shared with other spaces is not affected.
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
        aria-label="Type the space name to confirm deletion"
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
      setError(
        readableError(e.message) ??
          "Couldn't create the space. Check the name and try again."
      );
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
      isDismissable={!createMutation.isPending}
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1 border-b border-foreground/[0.06] px-6 py-4">
          <h2 className="text-[15px] font-medium text-foreground">
            Create space
          </h2>
          <p className="text-[12px] text-foreground/65">
            You'll be added as the owner. Profiles and members are set up in the
            app.
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
