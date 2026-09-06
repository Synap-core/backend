"use client";

/**
 * `SearchModal` — Pod Admin global search palette (⌘K).
 *
 * Categories indexed:
 *   • Workspaces       → `trpc.workspaces.adminListAll`
 *   • People (humans)  → `trpc.workspaces.listPodMembers`
 *   • Agents           → `trpc.system.listUsers({ type: "agent" })`
 *   • Trusted issuers  → `trpc.trustedIssuers.list`
 *   • API keys         → `trpc.apiKeys.adminListAll` (stub: surfaces names only)
 *   • Entities         → `trpc.entities.adminList` (SERVER-side `search`)
 *   • Proposals        → `trpc.proposals.list` (reviewable scope, every status)
 *   • Audit events     → `trpc.system.listAuditLogs` (stub: most recent 25)
 *
 * Selection navigates to the appropriate tab with `?focus=<id>` (and, when
 * needed, `?section=<sub-tab>`) so the receiver can scroll the row into
 * view + apply the temporary highlight ring. Two receivers do NOT honour
 * `?focus=` and are therefore linked without it: a workspace-scoped API key
 * goes to `/workspaces/<id>?tab=api-keys` (the pod-wide Trust & Keys list
 * skips workspace keys, so focusing one there would show nothing), and an
 * entity goes to `/entities`.
 *
 * Keyboard model:
 *   ⌘K / Ctrl+K  — toggle open
 *   ↑ / ↓        — move highlight
 *   Enter        — navigate
 *   Esc          — close (HeroUI Modal default)
 *
 * Empty state renders the first row of each category as the "default
 * landing" so the operator sees their pod at a glance.
 */

import { Input, Modal, ModalContent, ModalBody } from "@heroui/react";
import {
  Bot,
  Building2,
  CircleUser,
  ClipboardCheck,
  Database,
  KeyRound,
  Mailbox,
  Search,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  buildObjectActionTitle,
  resolveObjectNoun,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ResultCategory =
  | "workspace"
  | "person"
  | "agent"
  | "issuer"
  | "api-key"
  | "entity"
  | "proposal"
  | "audit";

interface SearchResult {
  id: string;
  category: ResultCategory;
  primary: string;
  secondary?: string;
  /** Where to navigate on selection. */
  href: string;
}

// ─── Category presentation ──────────────────────────────────────────

const CATEGORY_META: Record<
  ResultCategory,
  { label: string; tab: string; Icon: LucideIcon }
> = {
  workspace: { label: "Workspaces", tab: "Workspaces", Icon: Building2 },
  person: { label: "People", tab: "People", Icon: CircleUser },
  agent: { label: "Agents", tab: "People", Icon: Bot },
  issuer: { label: "Trusted issuers", tab: "Trust & Keys", Icon: ShieldCheck },
  "api-key": { label: "API keys", tab: "Trust & Keys", Icon: KeyRound },
  entity: { label: "Entities", tab: "Entities", Icon: Database },
  proposal: { label: "Proposals", tab: "Audit", Icon: ClipboardCheck },
  audit: { label: "Audit events", tab: "Audit", Icon: Mailbox },
};

// Per-bucket truncation so a noisy category doesn't crowd the others. Shared
// with the server-side `entities.adminList` limit so its page and the bucket
// cap can never disagree.
const PER_CATEGORY_WHEN_QUERIED = 8;
const PER_CATEGORY_DEFAULT = 4;

const CATEGORY_ORDER: ResultCategory[] = [
  "workspace",
  "person",
  "agent",
  "issuer",
  "api-key",
  "entity",
  "proposal",
  "audit",
];

// ─── Component ─────────────────────────────────────────────────────

export function SearchModal({ isOpen, onClose }: SearchModalProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset internal state every time the modal opens — operators expect a
  // clean slate, not whatever they typed last time.
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setActiveIdx(0);
    }
  }, [isOpen]);

  // Auto-focus the input on open. HeroUI sometimes steals focus during
  // its open transition; fire on a microtask to win the race.
  useEffect(() => {
    if (!isOpen) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [isOpen]);

  // ─── Queries (cached 30s, only loaded while modal is open) ──────

  const wsQuery = trpc.workspaces.adminListAll.useQuery(undefined, {
    enabled: isOpen,
    staleTime: 30_000,
  });

  const peopleQuery = trpc.workspaces.listPodMembers.useQuery(undefined, {
    enabled: isOpen,
    staleTime: 30_000,
  });

  const agentsQuery = trpc.system.listUsers.useQuery(
    { type: "agent", limit: 200 },
    { enabled: isOpen, staleTime: 30_000 }
  );

  const issuersQuery = trpc.trustedIssuers.list.useQuery(undefined, {
    enabled: isOpen,
    staleTime: 30_000,
  });

  const apiKeysQuery = trpc.apiKeys.adminListAll.useQuery(undefined, {
    enabled: isOpen,
    staleTime: 30_000,
  });

  // Entities are the pod's largest population, so this one filters SERVER-side
  // (`adminList` takes `search`) instead of client-side like the rest.
  const entitiesQuery = trpc.entities.adminList.useQuery(
    {
      search: query.trim() || undefined,
      limit: query.trim() ? PER_CATEGORY_WHEN_QUERIED : PER_CATEGORY_DEFAULT,
      offset: 0,
    },
    { enabled: isOpen, staleTime: 15_000 }
  );

  // `workspaceId` OMITTED — the server then floors on the viewer's lens ∪ what
  // they authored (`scope-conditions.ts`), which is every proposal they may
  // already review. `null` would have meant pod-wide only. Audit → Proposals
  // omits it too, so a result found here can always be focused there.
  const proposalsQuery = trpc.proposals.list.useQuery(
    { status: "all", limit: 100 },
    { enabled: isOpen, staleTime: 15_000 }
  );

  const auditQuery = trpc.system.listAuditLogs.useQuery(
    { limit: 25 },
    { enabled: isOpen, staleTime: 15_000 }
  );

  // ─── Build flat result list ──────────────────────────────────────

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    const matches: SearchResult[] = [];

    // With no query we show the most-recent few in each bucket.
    const cap = q ? PER_CATEGORY_WHEN_QUERIED : PER_CATEGORY_DEFAULT;

    // Workspaces
    const wsItems = (wsQuery.data ?? []) as unknown as Array<{
      id: string;
      name: string;
      memberCount: number;
      type: string;
    }>;
    let bucket: SearchResult[] = [];
    for (const ws of wsItems) {
      const hay = `${ws.name} ${ws.type}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      bucket.push({
        id: ws.id,
        category: "workspace",
        primary: ws.name,
        secondary: `${ws.memberCount} member${ws.memberCount === 1 ? "" : "s"} · ${ws.type}`,
        href: `/workspaces?focus=${encodeURIComponent(ws.id)}`,
      });
      if (bucket.length >= cap) break;
    }
    matches.push(...bucket);

    // People (humans)
    bucket = [];
    const peopleItems = peopleQuery.data ?? [];
    for (const p of peopleItems) {
      const hay = `${p.name ?? ""} ${p.email}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      bucket.push({
        id: p.id,
        category: "person",
        primary: p.name ?? p.email,
        secondary: `${p.email} · ${p.primaryRole} · ${p.workspaceCount} ws`,
        href: `/people?focus=${encodeURIComponent(p.id)}`,
      });
      if (bucket.length >= cap) break;
    }
    matches.push(...bucket);

    // Agents
    bucket = [];
    const agentItems = agentsQuery.data?.users ?? [];
    for (const a of agentItems) {
      const hay = `${a.name ?? ""} ${a.email}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const meta = (a.agentMetadata ?? {}) as { agentType?: string };
      bucket.push({
        id: a.id,
        category: "agent",
        primary: a.name ?? a.email,
        secondary: `${meta.agentType ?? "agent"} · ${a.workspaceMembershipCount} ws`,
        href: `/people?focus=${encodeURIComponent(a.id)}`,
      });
      if (bucket.length >= cap) break;
    }
    matches.push(...bucket);

    // Trusted issuers
    bucket = [];
    const issuerItems = (issuersQuery.data ?? []) as unknown as Array<{
      id: string;
      displayName: string;
      issuerUrl: string;
      status: string;
    }>;
    for (const i of issuerItems) {
      const hay = `${i.displayName} ${i.issuerUrl}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      bucket.push({
        id: i.id,
        category: "issuer",
        primary: i.displayName,
        secondary: `${i.issuerUrl} · ${resolveStatusLabel(i.status)}`,
        href: `/trust-keys?section=issuers&focus=${encodeURIComponent(i.id)}`,
      });
      if (bucket.length >= cap) break;
    }
    matches.push(...bucket);

    // API keys — routed BY SCOPE. Trust & Keys → API keys skips every
    // workspace-scoped key (`hubId` `workspace:<id>`), so linking one there
    // lands the operator on a page that filters it out; those go to the
    // workspace's own API-keys tab instead.
    bucket = [];
    const keyItems = apiKeysQuery.data ?? [];
    for (const k of keyItems) {
      const hay = `${k.keyName} ${k.keyPrefix}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const scopedWorkspaceId = k.hubId?.startsWith("workspace:")
        ? k.hubId.slice("workspace:".length)
        : null;
      bucket.push({
        id: k.id,
        category: "api-key",
        primary: k.keyName,
        secondary: `${k.keyPrefix}… · ${k.isActive ? "active" : "revoked"}`,
        href: scopedWorkspaceId
          ? `/workspaces/${encodeURIComponent(scopedWorkspaceId)}?tab=api-keys`
          : `/trust-keys?section=api-keys&focus=${encodeURIComponent(k.id)}`,
      });
      if (bucket.length >= cap) break;
    }
    matches.push(...bucket);

    // Entities — already filtered server-side, so no `q` test here. Kind
    // labelled through the ONE vocabulary door, never the raw profile slug.
    bucket = [];
    const entityItems = entitiesQuery.data?.items ?? [];
    for (const e of entityItems) {
      const noun = resolveObjectNoun(e.profileSlug);
      bucket.push({
        id: e.id,
        category: "entity",
        primary: e.title ?? noun,
        secondary: `${noun} · ${e.workspaceName ?? "Pod-wide"}`,
        href: "/entities",
      });
      if (bucket.length >= cap) break;
    }
    matches.push(...bucket);

    // Proposals — labelled via the ONE vocabulary door (never a bare UUID or
    // raw `proposalType`/`targetType` token).
    bucket = [];
    const proposalItems = proposalsQuery.data?.items ?? [];
    for (const p of proposalItems) {
      const title = buildObjectActionTitle({
        action: p.proposalType,
        objectKind: p.targetType,
        objectName: p.targetName ?? undefined,
      });
      // Workspace names come from the palette's own Workspaces query — the
      // proposal row carries only `workspaceId`, and a cross-workspace result
      // list with no scope is ambiguous.
      const workspaceLabel =
        p.workspaceId == null
          ? "Pod-wide"
          : (wsItems.find((w) => w.id === p.workspaceId)?.name ?? "Workspace");
      const hay =
        `${title} ${p.proposalType} ${p.targetType} ${workspaceLabel}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      bucket.push({
        id: p.id,
        category: "proposal",
        primary: title,
        secondary: `${resolveStatusLabel(p.status)} · ${workspaceLabel} · ${new Date(p.createdAt).toLocaleString()}`,
        href: `/audit?section=proposals&focus=${encodeURIComponent(p.id)}`,
      });
      if (bucket.length >= cap) break;
    }
    matches.push(...bucket);

    // Audit events — most recent first; backend already returns newest-first.
    bucket = [];
    const auditItems = auditQuery.data?.events ?? [];
    for (const ev of auditItems) {
      const hay =
        `${ev.action} ${ev.subjectType} ${ev.eventType}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      bucket.push({
        id: ev.id,
        category: "audit",
        primary: `${ev.action} · ${ev.subjectType}`,
        secondary: new Date(ev.timestamp).toLocaleString(),
        href: `/audit?section=activity&focus=${encodeURIComponent(ev.id)}`,
      });
      if (bucket.length >= cap) break;
    }
    matches.push(...bucket);

    return matches;
  }, [
    query,
    wsQuery.data,
    peopleQuery.data,
    agentsQuery.data,
    issuersQuery.data,
    apiKeysQuery.data,
    entitiesQuery.data,
    proposalsQuery.data,
    auditQuery.data,
  ]);

  // Group results for the visible list — order follows CATEGORY_ORDER so
  // the operator's eye walks down a stable shape.
  const groupedResults = useMemo(() => {
    const buckets = new Map<ResultCategory, SearchResult[]>();
    for (const r of results) {
      const arr = buckets.get(r.category) ?? [];
      arr.push(r);
      buckets.set(r.category, arr);
    }
    return CATEGORY_ORDER.map((cat) => ({
      category: cat,
      items: buckets.get(cat) ?? [],
    })).filter((g) => g.items.length > 0);
  }, [results]);

  // Clamp activeIdx whenever results change.
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(0);
  }, [results, activeIdx]);

  function handleSelect(r: SearchResult) {
    router.push(r.href);
    onClose();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[activeIdx];
      if (r) handleSelect(r);
    }
  }

  // Flatten index map (groupedResults → activeIdx in `results`) so we can
  // tell which row to highlight.
  let runningIdx = 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      placement="top"
      size="xl"
      backdrop="blur"
      hideCloseButton
      classNames={{
        base: "mt-[10vh]",
        wrapper: "items-start",
      }}
    >
      <ModalContent>
        {() => (
          <ModalBody className="gap-0 p-0">
            <div className="border-b border-foreground/[0.06] px-4 py-3">
              <Input
                ref={inputRef}
                size="md"
                radius="md"
                variant="flat"
                placeholder="Search this pod… workspaces, people, entities, issuers, proposals, audit events"
                value={query}
                onValueChange={setQuery}
                onKeyDown={handleKeyDown}
                startContent={
                  <Search className="h-3.5 w-3.5 text-foreground/45" />
                }
                aria-label="Pod admin search"
                classNames={{
                  inputWrapper: "h-10 bg-transparent shadow-none",
                  input: "text-[13.5px]",
                }}
              />
            </div>

            <div className="max-h-[60vh] overflow-y-auto py-2">
              {results.length === 0 ? (
                <SearchEmpty hasQuery={query.trim().length > 0} />
              ) : (
                groupedResults.map((g) => {
                  const meta = CATEGORY_META[g.category];
                  return (
                    <div key={g.category} className="px-2 pb-1">
                      <div className="px-2 py-1 text-[10.5px] font-medium uppercase tracking-wider text-foreground/45">
                        {meta.label}
                      </div>
                      {g.items.map((r) => {
                        const idx = runningIdx;
                        runningIdx += 1;
                        const active = idx === activeIdx;
                        return (
                          <SearchRow
                            key={`${r.category}-${r.id}`}
                            result={r}
                            active={active}
                            onSelect={handleSelect}
                            onHover={() => setActiveIdx(idx)}
                          />
                        );
                      })}
                    </div>
                  );
                })
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-foreground/[0.06] px-4 py-2 text-[10.5px] text-foreground/45">
              <span>
                <kbd className="font-mono">↑↓</kbd> navigate ·{" "}
                <kbd className="font-mono">↵</kbd> open ·{" "}
                <kbd className="font-mono">esc</kbd> close
              </span>
              <span className="tabular">
                {results.length} result{results.length === 1 ? "" : "s"}
              </span>
            </div>
          </ModalBody>
        )}
      </ModalContent>
    </Modal>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function SearchRow({
  result,
  active,
  onSelect,
  onHover,
}: {
  result: SearchResult;
  active: boolean;
  onSelect: (r: SearchResult) => void;
  onHover: () => void;
}) {
  const meta = CATEGORY_META[result.category];
  const Icon = meta.Icon;

  return (
    <button
      type="button"
      onClick={() => onSelect(result)}
      onMouseEnter={onHover}
      className={[
        "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left",
        "transition-colors",
        active
          ? "bg-foreground/[0.07] text-foreground"
          : "text-foreground/85 hover:bg-content2/50",
      ].join(" ")}
    >
      <Icon
        className="h-4 w-4 shrink-0 text-foreground/45"
        strokeWidth={2}
        aria-hidden
      />
      <div className="min-w-0 flex-1 flex flex-col">
        <span className="truncate text-[12.5px] font-medium">
          {result.primary}
        </span>
        {result.secondary && (
          <span className="truncate text-[11px] text-foreground/55">
            {result.secondary}
          </span>
        )}
      </div>
      <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] tracking-wider text-foreground/55">
        {meta.tab}
      </span>
    </button>
  );
}

function SearchEmpty({ hasQuery }: { hasQuery: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
      <p className="text-[12.5px] text-foreground/55">
        {hasQuery ? "No matches." : "Type to search across pod admin."}
      </p>
      {!hasQuery && (
        <p className="text-[11px] text-foreground/45">
          Workspaces · People · Trusted issuers · API keys · Entities ·
          Proposals · Audit events
        </p>
      )}
    </div>
  );
}
