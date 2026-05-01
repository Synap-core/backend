/**
 * Admin Entities Browser — read-only.
 *
 * Pod-wide by default (workspace selector = "All"); narrows to a single
 * workspace when one is selected via the sidebar's WorkspaceSwitcher.
 *
 * Filters: profile slug, search (matches title/preview/properties).
 * Click a row → modal with the full entity JSON.
 */

import { useMemo, useState } from "react";
import {
  Button,
  Card,
  Chip,
  Input,
  Modal,
  Spinner,
  Table,
  Text,
  useOverlayState,
} from "@heroui/react";
import {
  IconCube,
  IconLayoutGrid,
  IconSearch,
  IconRefresh,
  IconBuildingCommunity,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import { useWorkspace } from "../../lib/workspace";

const PAGE_SIZE = 50;

function timeSince(date: Date | string | null | undefined) {
  if (!date) return "—";
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function EntitiesPage() {
  const { workspaceId, isAllWorkspaces, workspaceName } = useWorkspace();

  const [profileSlug, setProfileSlug] = useState<string>("");
  const [searchInput, setSearchInput] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // workspaceId from context: string | null (null = "All workspaces").
  // Backend semantics: undefined = all pod-wide, null = pod-wide only,
  // string = that workspace. "All" maps to undefined.
  const wsParam = isAllWorkspaces ? undefined : workspaceId;

  const detailModal = useOverlayState({
    isOpen: !!selectedId,
    onOpenChange: (open) => {
      if (!open) setSelectedId(null);
    },
  });

  const listQuery = trpc.entities.adminList.useQuery(
    {
      workspaceId: wsParam,
      profileSlug: profileSlug || undefined,
      search: search || undefined,
      limit: PAGE_SIZE,
      offset,
    },
    { refetchInterval: 30_000, refetchOnWindowFocus: false }
  );

  const profilesQuery = trpc.entities.adminListProfiles.useQuery(
    { workspaceId: wsParam },
    { refetchInterval: 60_000, refetchOnWindowFocus: false }
  );

  const detailQuery = trpc.entities.adminGet.useQuery(
    { id: selectedId! },
    { enabled: !!selectedId }
  );

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;

  const profileOptions = useMemo(
    () => profilesQuery.data ?? [],
    [profilesQuery.data]
  );

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setOffset(0);
    setSearch(searchInput.trim());
  };

  const resetFilters = () => {
    setProfileSlug("");
    setSearchInput("");
    setSearch("");
    setOffset(0);
  };

  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <div className="w-full p-8">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <IconCube size={22} className="text-primary" />
            <h1 className="m-0 text-2xl font-bold text-foreground">Entities</h1>
            <Chip size="sm" variant="soft" color="default">
              {listQuery.isLoading ? "…" : `${total} entities`}
            </Chip>
          </div>
          <Text className="text-sm text-default-500">
            Read-only browser across all profiles. Edit/delete actions coming
            later.
          </Text>
        </div>
        <div className="flex items-center gap-2">
          <Chip
            size="sm"
            variant="soft"
            color={isAllWorkspaces ? "accent" : "secondary"}
            className="ring-1 ring-divider"
          >
            <span className="inline-flex items-center gap-1.5">
              {isAllWorkspaces ? (
                <IconLayoutGrid size={12} />
              ) : (
                <IconBuildingCommunity size={12} />
              )}
              {isAllWorkspaces
                ? "All workspaces"
                : (workspaceName ?? "Workspace")}
            </span>
          </Chip>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              void listQuery.refetch();
              void profilesQuery.refetch();
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              <IconRefresh size={14} />
              Refresh
            </span>
          </Button>
        </div>
      </div>

      {/* Filter row */}
      <Card className="mb-4 border border-divider">
        <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
          <form
            onSubmit={handleSearchSubmit}
            className="flex flex-1 items-center gap-2"
          >
            <div className="relative flex-1">
              <IconSearch
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-default-400"
              />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search title, preview, or properties…"
                className="pl-8"
              />
            </div>
            <Button type="submit" size="sm" variant="primary">
              Search
            </Button>
          </form>

          <div className="flex items-center gap-2">
            <select
              value={profileSlug}
              onChange={(e) => {
                setOffset(0);
                setProfileSlug(e.target.value);
              }}
              className="rounded-lg border border-divider bg-content1 px-3 py-2 text-xs text-foreground outline-none transition-colors hover:border-default-300 focus:border-primary focus:ring-2 focus:ring-primary/20"
              aria-label="Filter by profile"
            >
              <option value="">All profiles</option>
              {profileOptions.map((p) => (
                <option key={p.profileSlug} value={p.profileSlug}>
                  {p.profileSlug} ({p.count})
                </option>
              ))}
            </select>
            {(profileSlug || search) && (
              <Button size="sm" variant="ghost" onPress={resetFilters}>
                Clear
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Table */}
      <Card className="border border-divider">
        {listQuery.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner size="lg" color="accent" />
          </div>
        ) : listQuery.isError ? (
          <div className="rounded-medium border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            Failed to load entities: {listQuery.error.message}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-center">
            <IconCube size={28} className="text-default-300" />
            <Text className="text-sm font-medium text-default-600">
              No entities found
            </Text>
            <Text className="text-xs text-default-500">
              {search || profileSlug
                ? "Try clearing filters."
                : isAllWorkspaces
                  ? "There are no entities on this pod yet."
                  : `No entities in ${workspaceName ?? "this workspace"}.`}
            </Text>
          </div>
        ) : (
          <Table variant="secondary">
            <Table.ScrollContainer>
              <Table.Content aria-label="Entities table">
                <Table.Header>
                  <Table.Column>Title</Table.Column>
                  <Table.Column>Profile</Table.Column>
                  {isAllWorkspaces ? (
                    <Table.Column>Workspace</Table.Column>
                  ) : null}
                  <Table.Column>Updated</Table.Column>
                </Table.Header>
                <Table.Body>
                  {items.map((e) => (
                    <Table.Row
                      key={e.id}
                      id={e.id}
                      onClick={() => setSelectedId(e.id)}
                      className="cursor-pointer hover:bg-default-100"
                    >
                      <Table.Cell>
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground">
                            {e.title || (
                              <span className="text-default-400">Untitled</span>
                            )}
                          </span>
                          {e.preview ? (
                            <span className="line-clamp-1 text-xs text-default-500">
                              {e.preview}
                            </span>
                          ) : null}
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip size="sm" variant="soft" color="default">
                          {e.profileSlug}
                        </Chip>
                      </Table.Cell>
                      {isAllWorkspaces ? (
                        <Table.Cell>
                          {e.workspaceId ? (
                            <span className="text-xs text-default-600">
                              {e.workspaceName ?? (
                                <span className="font-mono text-default-400">
                                  {e.workspaceId.slice(0, 8)}…
                                </span>
                              )}
                            </span>
                          ) : (
                            <Chip size="sm" variant="soft" color="accent">
                              pod-wide
                            </Chip>
                          )}
                        </Table.Cell>
                      ) : null}
                      <Table.Cell>
                        <span className="text-xs text-default-500">
                          {timeSince(e.updatedAt)}
                        </span>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
      </Card>

      {/* Pagination */}
      {total > 0 && (
        <div className="mt-3 flex items-center justify-between">
          <Text className="text-xs text-default-500">
            Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of{" "}
            {total}
          </Text>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              isDisabled={!canPrev}
              onPress={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={!canNext}
              onPress={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Detail modal */}
      <Modal state={detailModal}>
        <Modal.Backdrop isDismissable>
          <Modal.Container size="lg" placement="center">
            <Modal.Dialog>
              <Modal.Header className="flex flex-col gap-1 border-b border-divider px-6 py-4">
                <div className="flex items-center gap-2">
                  <IconCube size={18} className="text-primary" />
                  <Modal.Heading className="text-lg font-semibold">
                    {detailQuery.data?.title || "Entity detail"}
                  </Modal.Heading>
                </div>
                <Modal.CloseTrigger className="absolute right-3 top-3" />
              </Modal.Header>
              <Modal.Body className="gap-4 px-6 py-4">
                {detailQuery.isLoading ? (
                  <div className="flex justify-center py-8">
                    <Spinner size="md" color="accent" />
                  </div>
                ) : detailQuery.isError ? (
                  <div className="rounded-medium border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
                    {detailQuery.error.message}
                  </div>
                ) : detailQuery.data ? (
                  <EntityDetailBody entity={detailQuery.data} />
                ) : null}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

function EntityDetailBody({
  entity,
}: {
  entity: {
    id: string;
    title: string | null;
    preview: string | null;
    type: string;
    workspaceId: string | null;
    workspaceName: string | null;
    userId: string;
    createdAt: Date | string;
    updatedAt: Date | string;
    properties: Record<string, unknown>;
    systemData: Record<string, unknown>;
    documentId: string | null;
    profileId: string | null;
    version: number;
  };
}) {
  const propsEntries = Object.entries(entity.properties ?? {});
  return (
    <div className="flex flex-col gap-4">
      {/* Meta grid */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <MetaRow
          label="ID"
          value={<span className="font-mono">{entity.id}</span>}
        />
        <MetaRow
          label="Profile"
          value={
            <Chip size="sm" variant="soft" color="default">
              {entity.type}
            </Chip>
          }
        />
        <MetaRow
          label="Workspace"
          value={
            entity.workspaceId ? (
              <span className="text-default-600">
                {entity.workspaceName ?? (
                  <span className="font-mono">
                    {entity.workspaceId.slice(0, 8)}…
                  </span>
                )}
              </span>
            ) : (
              <Chip size="sm" variant="soft" color="accent">
                pod-wide
              </Chip>
            )
          }
        />
        <MetaRow
          label="User"
          value={
            <span className="font-mono text-default-600">
              {entity.userId.slice(0, 12)}…
            </span>
          }
        />
        <MetaRow
          label="Created"
          value={
            <span className="text-default-600">
              {new Date(entity.createdAt).toLocaleString()}
            </span>
          }
        />
        <MetaRow
          label="Updated"
          value={
            <span className="text-default-600">
              {new Date(entity.updatedAt).toLocaleString()}
            </span>
          }
        />
        {entity.documentId ? (
          <MetaRow
            label="Document"
            value={
              <span className="font-mono text-default-600">
                {entity.documentId.slice(0, 8)}…
              </span>
            }
          />
        ) : null}
        <MetaRow
          label="Version"
          value={<span className="text-default-600">{entity.version}</span>}
        />
      </div>

      {entity.preview ? (
        <div className="flex flex-col gap-1">
          <Text className="text-xs font-semibold uppercase tracking-wide text-default-500">
            Preview
          </Text>
          <div className="rounded-lg border border-divider bg-default-50 p-3 text-sm text-foreground">
            {entity.preview}
          </div>
        </div>
      ) : null}

      {/* Property breakdown */}
      <div className="flex flex-col gap-1">
        <Text className="text-xs font-semibold uppercase tracking-wide text-default-500">
          Properties ({propsEntries.length})
        </Text>
        {propsEntries.length === 0 ? (
          <Text className="text-sm text-default-500">No properties.</Text>
        ) : (
          <div className="overflow-hidden rounded-lg border border-divider">
            <table className="w-full text-xs">
              <tbody>
                {propsEntries.map(([k, v]) => (
                  <tr
                    key={k}
                    className="border-b border-divider/60 last:border-b-0"
                  >
                    <td className="w-1/3 bg-default-50 px-3 py-2 align-top font-mono text-default-600">
                      {k}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <ValueRenderer value={v} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Raw JSON */}
      <details className="rounded-lg border border-divider">
        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-default-500 hover:bg-default-50">
          Raw JSON
        </summary>
        <pre className="max-h-96 overflow-auto border-t border-divider bg-default-50 p-3 font-mono text-[11px] text-foreground">
          {JSON.stringify(entity, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-default-400">
        {label}
      </span>
      <span>{value}</span>
    </div>
  );
}

function ValueRenderer({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-default-400">—</span>;
  }
  if (typeof value === "string") {
    return <span className="break-words text-foreground">{value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="font-mono text-foreground">{String(value)}</span>;
  }
  return (
    <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
