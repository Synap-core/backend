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
  Textarea,
  Tooltip,
  useDisclosure,
} from "@heroui/react";
import {
  Building2,
  ExternalLink,
  MoreHorizontal,
  Plus,
  Settings2,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { trpc } from "../../../lib/trpc";
import { DetailDrawer } from "../components/detail-drawer";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import { StatusPill, type StatusKind } from "../components/status-pill";
import { useFocusRow } from "../components/use-focus-row";
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
};

type WorkspaceStatus = {
  kind: StatusKind;
  label: "Active" | "Idle" | "Archived";
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function deriveStatus(ws: Workspace): WorkspaceStatus {
  const settings = (ws.settings ?? {}) as Record<string, unknown>;
  if (settings.archivedAt || settings.archived === true) {
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
  const createDisclosure = useDisclosure();
  const drawerDisclosure = useDisclosure();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 30_000,
  });

  // ?focus=<workspaceId> from ⌘K: open the drawer for that workspace and
  // (when the row is rendered) scroll-and-highlight it.
  const focusId = useFocusRow({ ready: !query.isLoading });
  useEffect(() => {
    if (focusId && !drawerDisclosure.isOpen) {
      setSelectedId(focusId);
      drawerDisclosure.onOpen();
    }
    // We intentionally only react when the focus param itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  // The api-types snapshot types `settings` as the structured
  // WorkspaceSettings interface; we treat it as a loose record here so
  // we can read optional keys (`archivedAt`, `systemSlug`) without
  // cluttering the types with optional-everywhere chains.
  const workspaces = (query.data ?? []) as unknown as Workspace[];

  const stats = useMemo(() => {
    let active = 0;
    for (const ws of workspaces) {
      if (deriveStatus(ws).label === "Active") active += 1;
    }
    return { total: workspaces.length, active };
  }, [workspaces]);

  const selected =
    selectedId != null
      ? (workspaces.find((ws) => ws.id === selectedId) ?? null)
      : null;

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
        hint="Click a row to see details · use Open in Studio to manage"
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
                  onSelect={() => {
                    setSelectedId(ws.id);
                    drawerDisclosure.onOpen();
                  }}
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

      <WorkspaceDrawer
        ws={selected}
        isOpen={drawerDisclosure.isOpen}
        onClose={drawerDisclosure.onClose}
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

  // The ResourceRow Icon slot is monochrome by design; we use a small
  // colored chip leading the primary text instead, rendered via the
  // primary string. Cleaner approach: keep the lucide Building2 icon
  // and overlay a colored dot via a second element — but ResourceRow
  // doesn't expose extra slots. Trade-off: we accept the monochrome
  // icon for now and let the status pill carry the color signal.
  return (
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
      actions={<WorkspaceRowActions ws={ws} isSystem={isSystem} />}
    />
  );
}

function WorkspaceRowActions({
  ws,
  isSystem,
}: {
  ws: Workspace;
  isSystem: boolean;
}) {
  return (
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
          {/* Archive: no `workspaces.archive` mutation exists yet — the
              field is detected via `settings.archivedAt`. We disable
              the action and leave the TODO. */}
          {/* TODO(phase-C): add `workspaces.archive` mutation, then wire
              this button to it (with a confirm step). */}
          <Tooltip
            content={
              isSystem
                ? "System workspaces (e.g. pod-admin) can't be archived."
                : "Coming soon — `workspaces.archive` not yet shipped."
            }
          >
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
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Drawer ─────────────────────────────────────────────────────────

function WorkspaceDrawer({
  ws,
  isOpen,
  onClose,
}: {
  ws: Workspace | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const membersQuery = trpc.workspaces.listMembers.useQuery(
    { workspaceId: ws?.id ?? "" },
    {
      enabled: !!ws?.id && isOpen,
      staleTime: 60_000,
    }
  );

  const owner = useMemo(() => {
    if (!membersQuery.data) return null;
    return (
      membersQuery.data.find(
        (m) => m.role === "owner" && m.user?.userType === "human"
      ) ?? null
    );
  }, [membersQuery.data]);

  const status = ws ? deriveStatus(ws) : null;
  const settingsPretty = ws ? JSON.stringify(ws.settings ?? {}, null, 2) : "{}";

  return (
    <DetailDrawer
      isOpen={isOpen}
      onClose={onClose}
      title={ws?.name ?? "—"}
      subtitle={ws ? <span className="font-mono">{ws.id}</span> : undefined}
      headerAccessory={
        <span
          aria-hidden
          className="glass-icon flex h-9 w-9 shrink-0 items-center justify-center text-[14px] font-semibold text-white"
          style={{ background: ws ? colorForWorkspace(ws) : undefined }}
        >
          {ws ? workspaceInitial(ws) : "?"}
        </span>
      }
      headerRight={
        status ? <StatusPill kind={status.kind} label={status.label} /> : null
      }
      footer={
        <>
          <Button variant="flat" radius="md" size="sm" onPress={onClose}>
            Close
          </Button>
          {ws ? (
            <Button
              as="a"
              href={studioDeepLinkForWorkspace(ws.id)}
              target="_blank"
              rel="noopener noreferrer"
              color="primary"
              variant="solid"
              radius="md"
              size="sm"
              endContent={<ExternalLink className="h-3.5 w-3.5" />}
            >
              Open in Studio
            </Button>
          ) : null}
        </>
      }
    >
      {ws ? (
        <div className="flex flex-col gap-4">
          {ws.description ? (
            <p className="text-[12.5px] text-foreground/55">{ws.description}</p>
          ) : null}
          <DetailRow label="Type" value={ws.type} />
          <DetailRow
            label="Members"
            value={`${ws.memberCount} ${
              ws.memberCount === 1 ? "member" : "members"
            }`}
          />
          <DetailRow
            label="Created"
            value={ws.createdAt ? new Date(ws.createdAt).toLocaleString() : "—"}
          />
          <DetailRow
            label="Last update"
            value={ws.updatedAt ? formatRelative(new Date(ws.updatedAt)) : "—"}
          />
          <DetailRow
            label="Subscription"
            value={
              ws.subscriptionTier
                ? `${ws.subscriptionTier}${
                    ws.subscriptionStatus ? ` · ${ws.subscriptionStatus}` : ""
                  }`
                : "—"
            }
          />

          <div>
            <h4 className="mb-2 text-[11px] uppercase tracking-wider text-foreground/45">
              Owner
            </h4>
            {membersQuery.isLoading ? (
              <p className="text-[12px] text-foreground/55">Loading…</p>
            ) : owner ? (
              <div className="flex items-center justify-between gap-3 rounded-md border border-foreground/[0.06] bg-foreground/[0.02] px-3 py-2">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[12.5px] font-medium text-foreground">
                    {owner.user.name ?? owner.user.email}
                  </span>
                  <span className="truncate font-mono text-[10.5px] text-foreground/40">
                    {owner.user.email}
                  </span>
                </div>
                <span className="shrink-0 text-[11px] text-foreground/55">
                  owner
                </span>
              </div>
            ) : (
              <p className="text-[12px] text-foreground/55">
                No human owner found.
              </p>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-[11px] uppercase tracking-wider text-foreground/45">
              Members ({membersQuery.data?.length ?? 0})
            </h4>
            {membersQuery.isLoading ? (
              <p className="text-[12px] text-foreground/55">Loading…</p>
            ) : membersQuery.data && membersQuery.data.length > 0 ? (
              <div className="flex flex-col gap-1">
                {membersQuery.data.slice(0, 8).map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between gap-3 rounded-md px-3 py-1.5 hover:bg-content2/40"
                  >
                    <span className="truncate text-[12px] text-foreground">
                      {m.user?.name ?? m.user?.email ?? m.userId}
                    </span>
                    <span className="shrink-0 text-[11px] text-foreground/55">
                      {m.role}
                    </span>
                  </div>
                ))}
                {membersQuery.data.length > 8 ? (
                  <p className="px-3 pt-1 text-[11px] text-foreground/45">
                    +{membersQuery.data.length - 8} more — open in Studio to see
                    all
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-[12px] text-foreground/55">No members.</p>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-[11px] uppercase tracking-wider text-foreground/45">
              Settings
            </h4>
            <pre className="max-h-[180px] overflow-auto rounded-md border border-foreground/[0.06] bg-foreground/[0.02] p-3 font-mono text-[10.5px] text-foreground/70">
              {settingsPretty}
            </pre>
          </div>
        </div>
      ) : null}
    </DetailDrawer>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] uppercase tracking-wider text-foreground/45">
        {label}
      </span>
      <span className="truncate text-right text-[12.5px] text-foreground">
        {value}
      </span>
    </div>
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
