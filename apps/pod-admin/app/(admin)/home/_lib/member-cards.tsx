"use client";

/**
 * A member's three Home cards (plan W4): My access, Made for you and Done
 * for you. What each shows is decided in `member-home-model.ts`; this file
 * reads and draws.
 *
 * Every card draws its five states apart (`CardState`): nothing for the
 * first 300 ms of a read, then a skeleton in the rows' shape; "offline" while
 * the browser has no network; a failed read with its Retry, never folded
 * into empty; empty as EXPLAIN (only an AI or an admin fills these, so the
 * words say why it is empty); and the rows. Each card owns its reads: one
 * failing read never blanks another card.
 *
 * The console has no live socket, so these reads refetch when the window
 * comes back into focus (the console's default is off).
 *
 * Pod content is never re-drawn here: a record made for the viewer is drawn
 * by the renderer the one resolution picks (`RenderedObject`, entity-card
 * slot), else its identity card. A pod without Synap's renderer bundle (a
 * self-hosted pod) gets the identity cards and nothing else.
 */

import { Button } from "@heroui/react";
import { Building2, ChevronRight, KeyRound, Laptop } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { useT } from "../../../../lib/i18n/locale-provider";
import { trpc } from "../../../../lib/trpc";
import { MAX_FRAMED_ENTITY_CARDS } from "../../../_lib/object/content/embed-view";
import { IdentityCard } from "../../../_lib/object/content/identity-card";
import { RenderedObject } from "../../../_lib/object/content/rendered-object";
import { kindIcon } from "../../../_lib/object/kind-icon";
import { TimelineList } from "../../../_lib/timeline/timeline-list";
import type { HistoryRow } from "../../history/_lib/history-rows";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { en as shellEn, fr as shellFr } from "../../components/copy";
import { SectionCard } from "../../components/section-card";
import { en, fr } from "./copy";
import {
  ARTIFACTS_CAP,
  ARTIFACTS_READ_LIMIT,
  artifactRows,
  cardState,
  computerRow,
  keyRow,
  RECEIPTS_ALL_HREF,
  RECEIPTS_CAP,
  RECEIPTS_INPUT,
  receiptRows,
  SKELETON_DELAY_MS,
  SPACES_CAP,
  spaceRows,
  type ArtifactRow,
  type CardState,
  type CountRow,
  type SpaceRow,
} from "./member-home-model";

const CATALOGS = { en, fr };
const SHELL_CATALOGS = { en: shellEn, fr: shellFr };

/** The console has no socket: these reads refresh when the window regains focus. */
const LIVE_READ = { staleTime: 30_000, refetchOnWindowFocus: true } as const;

/** True once `active` has held for `delayMs`: a fast read never flashes a skeleton. */
export function useShownAfter(
  active: boolean,
  delayMs: number = SKELETON_DELAY_MS
): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return shown;
}

/** One card body: the four states that are not rows, then the rows. */
function StateBody<T>({
  state,
  skeleton,
  rows = 3,
  failed,
  empty,
  onRetry,
  children,
}: {
  state: CardState<T>;
  /** The 300 ms have passed: a loading read draws its skeleton. */
  skeleton: boolean;
  rows?: number;
  failed: string;
  empty: string;
  onRetry: () => void;
  children: (value: T) => ReactNode;
}) {
  const t = useT(CATALOGS);
  switch (state.kind) {
    case "loading":
      return <ResourceRowSkeleton count={rows} />;
    case "offline":
      return <ResourceRowEmpty message={t("offline")} />;
    case "failed":
      return <ResourceRowError message={failed} onRetry={onRetry} />;
    case "empty":
      return <ResourceRowEmpty message={empty} />;
    case "ready":
      return <>{children(state.value)}</>;
  }
}

function ShowAll({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <div className="mt-2 flex justify-start">
      <Button size="sm" variant="light" radius="md" onPress={onPress}>
        {label}
      </Button>
    </div>
  );
}

// ─── My access ─────────────────────────────────────────────────────────

export function MyAccessCardView({
  spaces,
  computers,
  keys,
  skeleton,
  onRetry,
  onOpen,
}: {
  spaces: CardState<SpaceRow[]>;
  computers: CardState<CountRow>;
  keys: CardState<CountRow>;
  skeleton: boolean;
  onRetry: { spaces: () => void; computers: () => void; keys: () => void };
  onOpen: (href: string) => void;
}) {
  const t = useT(CATALOGS);
  const [all, setAll] = useState(false);
  return (
    <SectionCard title={t("access.title")} hint={t("access.hint")}>
      <StateBody
        state={spaces}
        skeleton={skeleton}
        rows={2}
        failed={t("access.spaces.failed")}
        empty={t("access.spaces.empty")}
        onRetry={onRetry.spaces}
      >
        {(rows) => (
          <>
            <div className="-mx-2 divide-y divide-foreground/[0.05]">
              {(all ? rows : rows.slice(0, SPACES_CAP)).map((row) => (
                <ResourceRow
                  key={row.id}
                  Icon={Building2}
                  primary={row.name}
                  secondary={row.role ?? undefined}
                  onSelect={() => onOpen(row.href)}
                />
              ))}
            </div>
            {!all && rows.length > SPACES_CAP && (
              <ShowAll
                label={t("access.spaces.showAll", { n: rows.length })}
                onPress={() => setAll(true)}
              />
            )}
          </>
        )}
      </StateBody>
      <div className="-mx-2 mt-2 divide-y divide-foreground/[0.05] border-t border-foreground/[0.05]">
        <CountRowView
          Icon={Laptop}
          label={t("access.computers")}
          state={computers}
          skeleton={skeleton}
          words={(n) => t("access.computers.count", { n })}
          failed={t("access.computers.failed")}
          onRetry={onRetry.computers}
          onOpen={onOpen}
        />
        <CountRowView
          Icon={KeyRound}
          label={t("access.keys")}
          state={keys}
          skeleton={skeleton}
          words={(n) => t("access.keys.count", { n })}
          failed={t("access.keys.failed")}
          onRetry={onRetry.keys}
          onOpen={onOpen}
        />
      </div>
    </SectionCard>
  );
}

/** One of the viewer's own lists as a row: its count, a door to its page. */
function CountRowView({
  Icon,
  label,
  state,
  skeleton,
  words,
  failed,
  onRetry,
  onOpen,
}: {
  Icon: typeof Laptop;
  label: string;
  state: CardState<CountRow>;
  skeleton: boolean;
  words: (n: number) => string;
  failed: string;
  onRetry: () => void;
  onOpen: (href: string) => void;
}) {
  const t = useT(CATALOGS);
  const shell = useT(SHELL_CATALOGS);
  switch (state.kind) {
    case "loading":
      return skeleton ? (
        <ResourceRowSkeleton count={1} />
      ) : (
        <div aria-busy="true" className="h-14" />
      );
    case "offline":
      return (
        <ResourceRow Icon={Icon} primary={label} secondary={t("offline")} />
      );
    case "failed":
      return (
        <ResourceRow
          Icon={Icon}
          primary={label}
          secondary={failed}
          actions={
            <Button size="sm" variant="flat" radius="md" onPress={onRetry}>
              {shell("retry")}
            </Button>
          }
        />
      );
    // A count is never empty: zero is an answer, and its page is where the
    // first one is added.
    case "empty":
    case "ready": {
      const row = state.kind === "ready" ? state.value : null;
      const href = row?.href;
      return (
        <ResourceRow
          Icon={Icon}
          primary={label}
          secondary={words(row?.count ?? 0)}
          onSelect={href ? () => onOpen(href) : undefined}
        />
      );
    }
  }
}

export function MyAccessCard() {
  const router = useRouter();
  const spaces = trpc.workspaces.list.useQuery(undefined, LIVE_READ);
  const computers = trpc.machines.list.useQuery(undefined, LIVE_READ);
  const keys = trpc.apiKeys.list.useQuery(undefined, LIVE_READ);
  const skeleton = useShownAfter(
    spaces.isLoading || computers.isLoading || keys.isLoading
  );
  return (
    <MyAccessCardView
      spaces={cardState(spaces, spaceRows)}
      computers={cardState(computers, computerRow)}
      keys={cardState(keys, keyRow)}
      skeleton={skeleton}
      onRetry={{
        spaces: () => void spaces.refetch(),
        computers: () => void computers.refetch(),
        keys: () => void keys.refetch(),
      }}
      onOpen={(href) => router.push(href)}
    />
  );
}

// ─── Made for you ──────────────────────────────────────────────────────

/** A row's identity card: what it is, its title, a door to its page. */
function ArtifactIdentity({ row }: { row: ArtifactRow }) {
  const Icon = row.card
    ? kindIcon("entity", {
        slug: row.card.profileSlug,
        uiHints: { icon: row.card.icon },
      })
    : kindIcon(row.kind);
  return (
    <IdentityCard
      href={row.href}
      Icon={Icon}
      title={row.title}
      noun={row.noun}
    />
  );
}

/**
 * One row: the first `MAX_FRAMED_ENTITY_CARDS` records go to the renderer
 * the one resolution picks (each frame carries the bundle, ~3 MB, the cap
 * `embed-view` set for a body); every other row is its identity card.
 */
function ArtifactRowView({
  row,
  framed,
}: {
  row: ArtifactRow;
  framed: boolean;
}) {
  const identity = <ArtifactIdentity row={row} />;
  if (!framed || !row.card) return identity;
  return (
    <RenderedObject
      subject={{
        kind: "entity",
        slot: "entity-card",
        entityId: row.card.entityId,
        profileSlug: row.card.profileSlug,
      }}
      workspaceId={row.workspaceId}
      title={row.title}
      fallback={identity}
      drawnFooter={
        <Link
          href={row.href}
          className="text-[12.5px] text-foreground/75 underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
        >
          {row.title}
        </Link>
      }
    />
  );
}

export function MadeForYouCardView({
  state,
  skeleton,
  onRetry,
}: {
  state: CardState<ArtifactRow[]>;
  skeleton: boolean;
  onRetry: () => void;
}) {
  const t = useT(CATALOGS);
  const [all, setAll] = useState(false);
  return (
    <SectionCard title={t("artifacts.title")} hint={t("artifacts.hint")}>
      <StateBody
        state={state}
        skeleton={skeleton}
        failed={t("artifacts.failed")}
        empty={t("artifacts.empty")}
        onRetry={onRetry}
      >
        {(rows) => {
          let framed = 0;
          return (
            <>
              <ul className="flex flex-col gap-2">
                {(all ? rows : rows.slice(0, ARTIFACTS_CAP)).map((row) => {
                  const frame =
                    row.card !== null && framed < 99;
                  if (frame) framed += 1;
                  return (
                    <li key={row.id}>
                      <ArtifactRowView row={row} framed={frame} />
                    </li>
                  );
                })}
              </ul>
              {!all && rows.length > ARTIFACTS_CAP && (
                <ShowAll
                  label={t("artifacts.showAll", { n: rows.length })}
                  onPress={() => setAll(true)}
                />
              )}
            </>
          );
        }}
      </StateBody>
    </SectionCard>
  );
}

export function MadeForYouCard() {
  const me = trpc.users.me.useQuery(undefined, { staleTime: 300_000 });
  const ledger = trpc.artifacts.list.useQuery(
    { limit: ARTIFACTS_READ_LIMIT },
    LIVE_READ
  );
  const viewerId = me.data?.id;
  const state = cardState(
    {
      isError: me.isError || ledger.isError,
      data:
        viewerId !== undefined && ledger.data !== undefined
          ? { viewerId, items: ledger.data }
          : undefined,
      fetchStatus:
        me.fetchStatus === "paused" || ledger.fetchStatus === "paused"
          ? "paused"
          : ledger.fetchStatus,
    },
    (d) => artifactRows(d.items, d.viewerId)
  );
  const skeleton = useShownAfter(state.kind === "loading");
  return (
    <MadeForYouCardView
      state={state}
      skeleton={skeleton}
      onRetry={() => {
        if (me.isError) void me.refetch();
        void ledger.refetch();
      }}
    />
  );
}

// ─── Done for you (receipts) ───────────────────────────────────────────

export function DoneForYouCardView({
  state,
  skeleton,
  onRetry,
  onOpen,
}: {
  state: CardState<HistoryRow[]>;
  skeleton: boolean;
  onRetry: () => void;
  onOpen: (href: string) => void;
}) {
  const t = useT(CATALOGS);
  return (
    <SectionCard
      title={t("receipts.title")}
      hint={t("receipts.hint")}
      actions={
        <Button
          as={Link}
          href={RECEIPTS_ALL_HREF}
          size="sm"
          variant="flat"
          radius="md"
          endContent={<ChevronRight className="h-3 w-3" />}
        >
          {t("receipts.all")}
        </Button>
      }
    >
      <StateBody
        state={state}
        skeleton={skeleton}
        failed={t("receipts.failed")}
        empty={t("receipts.empty")}
        onRetry={onRetry}
      >
        {(rows) => {
          const byKey = new Map(rows.map((r) => [r.entry.key, r]));
          return (
            <div className="-mx-2">
              <TimelineList
                entries={rows.map((r) => r.entry)}
                cap={RECEIPTS_CAP}
                expanded={false}
                onExpand={() => onOpen(RECEIPTS_ALL_HREF)}
                showAllLabel={t("receipts.all")}
                onSelect={(e) => {
                  const row = byKey.get(e.key);
                  if (row) onOpen(row.href);
                }}
                detail={(e) => byKey.get(e.key)?.kindLabel ?? null}
              />
            </div>
          );
        }}
      </StateBody>
    </SectionCard>
  );
}

export function DoneForYouCard() {
  const router = useRouter();
  const list = trpc.proposals.list.useQuery(RECEIPTS_INPUT, LIVE_READ);
  const state = cardState(list, (d) => receiptRows(d.items));
  const skeleton = useShownAfter(state.kind === "loading");
  return (
    <DoneForYouCardView
      state={state}
      skeleton={skeleton}
      onRetry={() => void list.refetch()}
      onOpen={(href) => router.push(href)}
    />
  );
}

/** The member's part of Home: what was made, what was done, what they reach. */
export function MemberHomeCards() {
  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MadeForYouCard />
        <DoneForYouCard />
      </div>
      <MyAccessCard />
    </div>
  );
}
