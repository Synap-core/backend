"use client";

/**
 * Entities tab — pod-wide entity browser with delete capabilities.
 *
 * Features:
 *   1. Filter by profileSlug (dropdown), workspaceId (text input or null toggle), search
 *   2. Paginated table (limit 50) with title, type, workspace, created-by, created-at
 *   3. Per-row delete via `entities.adminDelete` with inline confirmation
 *   4. Bulk select + bulk delete via `entities.adminBatchDelete`
 *   5. Toast notifications after deletions
 */

import {
  addToast,
  Button,
  Checkbox,
  Input,
  Select,
  SelectItem,
  Spinner as _Spinner,
  Switch,
} from "@heroui/react";
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Search,
  Trash2,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { ConfirmModal } from "../components/confirm-modal";
import { SectionCard } from "../components/section-card";
import { formatRelative } from "../people/_lib/helpers";

// ─── Types ────────────────────────────────────────────────────────────

type EntityRow = {
  id: string;
  title: string | null;
  profileSlug: string;
  workspaceId: string | null;
  workspaceName: string | null;
  userId: string;
  createdAt: Date | string;
  propertiesPreview: string;
};

// ─── Page shell ───────────────────────────────────────────────────────

export default function EntitiesPage() {
  return (
    <Suspense fallback={<EntitiesFallback />}>
      <EntitiesInner />
    </Suspense>
  );
}

function EntitiesFallback() {
  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          Entities
        </h1>
      </header>
      <div className="h-9 w-full max-w-md rounded-md bg-foreground/[0.05] shimmer-pulse" />
    </div>
  );
}

// ─── Main inner component ─────────────────────────────────────────────

function EntitiesInner() {
  const [search, setSearch] = useState("");
  const [profileSlug, setProfileSlug] = useState<string>("");
  const [workspaceIdInput, setWorkspaceIdInput] = useState("");
  const [podWideOnly, setPodWideOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const LIMIT = 50;

  // Compute the effective workspaceId filter
  const workspaceIdFilter: string | null | undefined = useMemo(() => {
    if (podWideOnly) return null;
    const trimmed = workspaceIdInput.trim();
    if (trimmed.length === 36) return trimmed; // UUID length
    return undefined; // no filter
  }, [podWideOnly, workspaceIdInput]);

  const utils = trpc.useUtils();

  const profilesQuery = trpc.entities.adminListProfiles.useQuery(
    { workspaceId: workspaceIdFilter },
    { staleTime: 30_000 }
  );

  const entitiesQuery = trpc.entities.adminList.useQuery(
    {
      search: search.trim() || undefined,
      profileSlug: profileSlug || undefined,
      workspaceId: workspaceIdFilter,
      limit: LIMIT,
      offset,
    },
    { staleTime: 15_000 }
  );

  // Reset offset when filters change
  useEffect(() => {
    setOffset(0);
    setSelectedIds(new Set());
  }, [search, profileSlug, workspaceIdInput, podWideOnly]);

  // Expired session → login, not a dead "couldn't load" error.
  useEffect(() => {
    if (entitiesQuery.isError) {
      redirectToLoginIfUnauthorized(entitiesQuery.error);
    }
  }, [entitiesQuery.isError, entitiesQuery.error]);
  const isAuthRedirecting = entitiesQuery.error?.data?.code === "UNAUTHORIZED";

  const items = (entitiesQuery.data?.items ?? []) as EntityRow[];
  const total = entitiesQuery.data?.total ?? 0;
  const pageCount = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  const profiles = profilesQuery.data ?? [];

  const allSelected =
    items.length > 0 && items.every((item) => selectedIds.has(item.id));
  const someSelected = selectedIds.size > 0;

  function toggleAll() {
    if (allSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const item of items) next.delete(item.id);
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const item of items) next.add(item.id);
        return next;
      });
    }
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const batchDeleteMutation = trpc.entities.adminBatchDelete.useMutation({
    onSuccess: (data) => {
      void utils.entities.adminList.invalidate();
      void utils.entities.adminListProfiles.invalidate();
      setSelectedIds(new Set());
      setConfirmBulkDelete(false);
      addToast({
        title: "Entities deleted",
        description: `${data.deletedCount} ${data.deletedCount === 1 ? "entity" : "entities"} permanently deleted.`,
        color: "default",
      });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Bulk delete failed",
        description: err.message,
        color: "danger",
      });
      setConfirmBulkDelete(false);
    },
  });

  function handleBulkDelete() {
    batchDeleteMutation.mutate({ ids: Array.from(selectedIds) });
  }

  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
            Entities
          </h1>
          <p className="text-[13px] text-foreground/55">
            All entities on this pod. Deletions are permanent and cannot be
            undone.
          </p>
        </div>
        {someSelected && (
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-foreground/55">
              {selectedIds.size} selected
            </span>
            <Button
              color="danger"
              variant="flat"
              radius="md"
              size="sm"
              startContent={<Trash2 className="h-3.5 w-3.5" />}
              onPress={() => setConfirmBulkDelete(true)}
            >
              Delete selected
            </Button>
          </div>
        )}
      </header>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-full max-w-xs">
          <Input
            placeholder="Search title, preview, properties…"
            value={search}
            onValueChange={setSearch}
            radius="md"
            variant="flat"
            size="sm"
            startContent={<Search className="h-3.5 w-3.5 text-foreground/40" />}
            isClearable
            onClear={() => setSearch("")}
          />
        </div>

        <div className="w-48">
          <Select
            placeholder="All types"
            selectedKeys={profileSlug ? new Set([profileSlug]) : new Set()}
            onSelectionChange={(keys) => {
              const val = Array.from(keys)[0];
              setProfileSlug(typeof val === "string" ? val : "");
            }}
            radius="md"
            variant="flat"
            size="sm"
            aria-label="Filter by profile type"
          >
            {[
              <SelectItem key="" textValue="All types">
                All types
              </SelectItem>,
              ...profiles.map((p) => (
                <SelectItem key={p.profileSlug} textValue={p.profileSlug}>
                  {p.profileSlug}{" "}
                  <span className="text-foreground/45">({p.count})</span>
                </SelectItem>
              )),
            ]}
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-[12px] text-foreground/65">
            <Switch
              size="sm"
              isSelected={podWideOnly}
              onValueChange={(v) => {
                setPodWideOnly(v);
                if (v) setWorkspaceIdInput("");
              }}
              aria-label="Pod-wide only (no workspace)"
            />
            Pod-wide only
          </label>
        </div>

        {!podWideOnly && (
          <div className="w-72">
            <Input
              placeholder="Filter by workspace UUID…"
              value={workspaceIdInput}
              onValueChange={setWorkspaceIdInput}
              radius="md"
              variant="flat"
              size="sm"
              isClearable
              onClear={() => setWorkspaceIdInput("")}
            />
          </div>
        )}
      </div>

      <SectionCard
        title={`Entities${total > 0 ? ` (${total})` : ""}`}
        hint="Click the trash icon to delete a row · use checkboxes for bulk deletion"
        actions={
          pageCount > 1 ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-foreground/55">
                Page {currentPage} / {pageCount}
              </span>
              <Button
                isIconOnly
                variant="light"
                size="sm"
                radius="full"
                isDisabled={offset === 0}
                onPress={() => setOffset(Math.max(0, offset - LIMIT))}
                aria-label="Previous page"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                isIconOnly
                variant="light"
                size="sm"
                radius="full"
                isDisabled={offset + LIMIT >= total}
                onPress={() => setOffset(offset + LIMIT)}
                aria-label="Next page"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null
        }
      >
        {entitiesQuery.isLoading || isAuthRedirecting ? (
          <ResourceRowSkeleton count={6} />
        ) : entitiesQuery.isError ? (
          <ResourceRowError message="Couldn't load entities." />
        ) : items.length === 0 ? (
          <ResourceRowEmpty message="No entities match the current filters." />
        ) : (
          <div className="flex flex-col">
            {/* Table header */}
            <div className="flex items-center gap-3 border-b border-foreground/[0.06] px-3 pb-2 pt-1">
              <Checkbox
                size="sm"
                isSelected={allSelected}
                isIndeterminate={someSelected && !allSelected}
                onValueChange={toggleAll}
                aria-label="Select all on this page"
              />
              <div className="grid flex-1 grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] gap-3 text-[10.5px] font-medium uppercase tracking-wider text-foreground/40">
                <span>Title</span>
                <span>Type</span>
                <span>Workspace</span>
                <span>Created by</span>
                <span>Created</span>
                <span />
              </div>
            </div>

            {/* Rows */}
            {items.map((item) => (
              <EntityTableRow
                key={item.id}
                item={item}
                isSelected={selectedIds.has(item.id)}
                onToggle={() => toggleOne(item.id)}
                onDeleted={() => {
                  void utils.entities.adminList.invalidate();
                  void utils.entities.adminListProfiles.invalidate();
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    next.delete(item.id);
                    return next;
                  });
                }}
              />
            ))}
          </div>
        )}
      </SectionCard>

      {/* Bulk delete confirm */}
      <ConfirmModal
        isOpen={confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        onConfirm={handleBulkDelete}
        title={`Delete ${selectedIds.size} entities?`}
        consequence={
          <>
            <p>
              This permanently deletes {selectedIds.size} entities from the
              database, along with the documents and stored files each one
              owned. This cannot be undone.
            </p>
            <p className="mt-2">
              Other entities that reference them are not deleted.
            </p>
          </>
        }
        confirmLabel={`Delete ${selectedIds.size} entities`}
        isPending={batchDeleteMutation.isPending}
      />
    </div>
  );
}

// ─── Entity table row ─────────────────────────────────────────────────

function EntityTableRow({
  item,
  isSelected,
  onToggle,
  onDeleted,
}: {
  item: EntityRow;
  isSelected: boolean;
  onToggle: () => void;
  onDeleted: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteMutation = trpc.entities.adminDelete.useMutation({
    onSuccess: () => {
      addToast({
        title: "Entity deleted",
        description: `"${item.title ?? item.id.slice(0, 8)}" permanently deleted.`,
        color: "default",
      });
      onDeleted();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Delete failed",
        description: err.message,
        color: "danger",
      });
      setConfirmDelete(false);
    },
  });

  return (
    <>
      <div className="group flex items-center gap-3 rounded-md px-3 py-2 hover:bg-content2/30">
        <Checkbox
          size="sm"
          isSelected={isSelected}
          onValueChange={onToggle}
          aria-label={`Select entity ${item.id}`}
        />
        <div className="grid flex-1 grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] items-center gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Database className="h-3.5 w-3.5 shrink-0 text-foreground/35" />
            <span className="truncate text-[12.5px] text-foreground">
              {item.title ?? (
                <span className="text-foreground/40 italic">Untitled</span>
              )}
            </span>
          </div>
          <span className="truncate font-mono text-[11px] text-foreground/65">
            {item.profileSlug}
          </span>
          <span className="truncate font-mono text-[11px] text-foreground/55">
            {item.workspaceName ? (
              item.workspaceName
            ) : item.workspaceId ? (
              item.workspaceId.slice(0, 8) + "…"
            ) : (
              <span className="text-foreground/35">Pod-wide</span>
            )}
          </span>
          <span className="truncate font-mono text-[11px] text-foreground/45">
            {item.userId.slice(0, 8)}…
          </span>
          <span className="truncate text-[11px] text-foreground/45">
            {item.createdAt
              ? formatRelative(
                  item.createdAt instanceof Date
                    ? item.createdAt
                    : new Date(item.createdAt)
                )
              : "—"}
          </span>
          <Button
            isIconOnly
            variant="light"
            size="sm"
            radius="full"
            color="danger"
            aria-label={`Delete entity ${item.id}`}
            className="opacity-0 transition-opacity group-hover:opacity-100"
            onPress={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ConfirmModal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => deleteMutation.mutate({ id: item.id })}
        title={`Delete "${item.title ?? item.id.slice(0, 8)}"?`}
        consequence={
          <>
            <p>
              This permanently deletes the entity from the database, along with
              the documents and stored files it owned. This cannot be undone.
            </p>
            <p className="mt-2">
              Other entities that reference it are not deleted.
            </p>
          </>
        }
        confirmLabel="Delete entity"
        isPending={deleteMutation.isPending}
      />
    </>
  );
}
