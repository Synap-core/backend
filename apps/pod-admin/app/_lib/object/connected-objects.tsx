"use client";

/**
 * "Connected": the objects this one is wired to. The rule (groups, labels,
 * suggestions) lives in `@synap-core/types/connections`; this file reads its
 * two doors and draws the answer, read-only. Previews are lazy: the first
 * MEDIA_READS files only, and only the first HTML page is framed.
 *
 * Not passed: `keyFactIds`, so a tie already drawn as a field can appear
 * twice (a known divergence from the desktop app).
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Box } from "lucide-react";
import { Button, Chip } from "@heroui/react";
import {
  connectionsState,
  groupWireConnections,
  suggestWireConnections,
  type ConnectionGroup,
  type ConnectionItem,
  type WireGraphNeighbor,
  type WireRelationType,
} from "@synap-core/types/connections";
import { trpc } from "../../../lib/trpc";
import { ResourceRowError } from "../../(admin)/components/resource-row";
import { SectionCard } from "../../(admin)/components/section-card";
import { openT } from "../../open/copy";
import { kindIcon, kindLabel } from "./kind-icon";
import { MediaView } from "../media/media-view";
import { objectPage } from "./content/markdown-model";
import { HtmlPagePreview } from "./content/html-preview";
import { DocumentContentSection } from "./content/content-block";
import { useDocumentContent } from "./content/use-document-content";
import { OpenInAppLink } from "./open-in-app-link";
import {
  GROUP_CAP,
  collapsedItems,
  neighbourMedia,
  visibleItems,
  type FileRead,
  type NeighbourMedia,
} from "./connected-media";

const MEDIA_READS = 4;
const THUMB = "h-40 w-full max-w-[16rem]";

const DOOR =
  "inline-flex min-w-0 items-center gap-1.5 rounded-sm text-[13px] [overflow-wrap:anywhere] text-foreground/80 underline decoration-foreground/25 underline-offset-2 hover:text-foreground hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

type Preview =
  | { state: "pending" }
  | { state: "failed"; retry: () => void }
  | { state: "ready"; media: NeighbourMedia };

/** Reads the first MEDIA_READS connected files; pending is not failed. */
function useFilePreviews(items: readonly ConnectionItem[]) {
  const files = items.filter((i) => i.kind === "file").slice(0, MEDIA_READS);
  const reads = trpc.useQueries((q) =>
    files.map((f) =>
      q.entities.get({ id: f.id }, { retry: false, staleTime: 30_000 })
    )
  );
  const previews = new Map<string, Preview>();
  files.forEach((f, i) => {
    const r = reads[i];
    previews.set(
      f.id,
      r?.data
        ? { state: "ready", media: neighbourMedia(f.id, r.data as FileRead) }
        : r?.isError
          ? { state: "failed", retry: () => void r.refetch() }
          : { state: "pending" }
    );
  });
  return { files, previews };
}

function Door({
  item,
  hidden,
  showKind,
}: {
  item: ConnectionItem;
  hidden: boolean;
  showKind: boolean;
}) {
  const t = openT();
  // A hidden far end reveals nothing, not even its kind.
  const Icon = hidden ? Box : kindIcon(item.kind);
  const href = hidden ? null : objectPage(item.graphKind, item.id);
  const name = hidden
    ? t("connected.hidden")
    : item.name.trim() || t("connected.untitled");
  return (
    <span className="flex min-h-6 min-w-0 items-center gap-2 py-0.5">
      <Icon aria-hidden className="h-4 w-4 shrink-0 text-foreground/50" />
      {href ? (
        <Link href={href} className={DOOR}>
          {name}
        </Link>
      ) : (
        <span className="text-[13px] text-foreground/60 [overflow-wrap:anywhere]">
          {name}
        </span>
      )}
      {showKind && !hidden && (
        <span className="shrink-0 text-[12px] text-foreground/50">
          {kindLabel(item.kind)}
        </span>
      )}
    </span>
  );
}

function Group({
  group,
  hiddenIds,
  previews,
}: {
  group: ConnectionGroup;
  hiddenIds: ReadonlySet<string>;
  previews: ReadonlyMap<string, Preview>;
}) {
  const t = openT();
  const [expanded, setExpanded] = useState(false);
  const items = visibleItems(group, { expanded });
  const showKind = new Set(group.items.map((i) => i.kind)).size > 1;
  const imageOf = (item: ConnectionItem) => {
    const p = previews.get(item.id);
    return p?.state === "ready" && p.media.kind === "image" ? p.media : null;
  };
  const isFigure = (item: ConnectionItem) =>
    previews.get(item.id)?.state === "pending" || imageOf(item) !== null;
  const figures = items.filter(isFigure);
  const rows = items.filter((i) => !isFigure(i));
  return (
    <div data-group={group.key}>
      <h4 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-foreground/65">
        {group.reversed && (
          <ArrowLeft
            role="img"
            aria-label={t("connected.reversed")}
            className="h-3 w-3"
            data-reversed="true"
          >
            <title>{t("connected.reversed")}</title>
          </ArrowLeft>
        )}
        {group.label}
        <span className="text-foreground/45">{group.total}</span>
      </h4>
      {figures.length > 0 && (
        <ul className="mb-1.5 flex flex-wrap items-start gap-3">
          {figures.map((item) => {
            const image = imageOf(item);
            return (
              <li
                key={`${item.graphKind}:${item.id}`}
                className="flex min-w-0 flex-col gap-1.5"
              >
                {image ? (
                  <MediaView
                    media={image.media}
                    alt={item.name.trim() || t("connected.untitled")}
                    size="thumb"
                    viaEntityId={item.id}
                  />
                ) : (
                  <div
                    aria-hidden
                    className={`${THUMB} rounded-lg bg-foreground/[0.07] shimmer-pulse`}
                  />
                )}
                <Door
                  item={item}
                  hidden={hiddenIds.has(item.id)}
                  showKind={showKind}
                />
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((item) => {
            const p = previews.get(item.id);
            return (
              <li
                key={`${item.graphKind}:${item.id}`}
                className="flex min-w-0 flex-wrap items-center gap-x-2"
              >
                <Door
                  item={item}
                  hidden={hiddenIds.has(item.id)}
                  showKind={showKind}
                />
                {p?.state === "failed" && (
                  <>
                    <span className="text-[12px] text-status-down">
                      {t("connected.previewFailed")}
                    </span>
                    <Button
                      size="sm"
                      variant="light"
                      radius="md"
                      onPress={p.retry}
                    >
                      {t("connected.retry")}
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {group.total > GROUP_CAP && (
        <Button
          size="sm"
          variant="light"
          radius="md"
          className="mt-1.5"
          aria-expanded={expanded}
          aria-label={`${
            expanded
              ? t("connected.showLess")
              : t("connected.showAll", { n: group.total })
          }, ${group.label}`}
          onPress={() => setExpanded((v) => !v)}
        >
          {expanded
            ? t("connected.showLess")
            : t("connected.showAll", { n: group.total })}
        </Button>
      )}
    </div>
  );
}

/** A stored HTML file's page, drawn WITHOUT the pod bridge: it is another object's file. */
function ConnectedPage({
  documentId,
  title,
}: {
  documentId: string;
  title: string;
}) {
  const t = openT();
  const body = useDocumentContent(documentId);
  if (body.content?.kind === "page") {
    return (
      <SectionCard variant="flat" title={title}>
        <HtmlPagePreview
          html={body.content.html}
          title={title}
          workspaceId={body.content.workspaceId}
          note={t("connected.pageNote")}
        />
      </SectionCard>
    );
  }
  return (
    <DocumentContentSection
      title={title}
      content={body.content}
      onRetry={body.retry}
    />
  );
}

export function ConnectedObjects({
  entityId,
  kind,
  definitions,
}: {
  entityId: string;
  kind: string;
  definitions?: readonly unknown[];
}) {
  const t = openT();
  const graph = trpc.graph.getObjectGraph.useQuery(
    { type: "entity", id: entityId },
    { retry: false }
  );
  const types = trpc.relations.listTypes.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60_000,
  });

  const read = connectionsState(graph);
  // The vocabulary is for the WORDS of each group: wait for it (no slug
  // flash); if it fails every tie still shows, named plainly.
  const typesPending = types.data === undefined && !types.isError;
  const neighbors = (
    graph.data as { neighbors?: readonly WireGraphNeighbor[] } | undefined
  )?.neighbors;
  const typeRows = types.data?.types as readonly WireRelationType[] | undefined;
  const grouped = useMemo(
    () =>
      groupWireConnections({
        neighbors: read.missing ? [] : neighbors,
        relationTypes: typeRows,
      }),
    [neighbors, typeRows, read.missing]
  );
  // `ConnectionItem` drops `hidden` (a far end the reader cannot see: its
  // name is a raw id); the raw neighbours still know.
  const hiddenIds = useMemo(
    () => new Set((neighbors ?? []).filter((n) => n.hidden).map((n) => n.id)),
    [neighbors]
  );
  // Previews come from the COLLAPSED set, so expanding a group never changes
  // which are read or which page is open.
  const { files, previews } = useFilePreviews(
    collapsedItems(grouped.groups, hiddenIds)
  );
  const page = files.flatMap((f) => {
    const p = previews.get(f.id);
    return p?.state === "ready" && p.media.kind === "page"
      ? [{ item: f, documentId: p.media.documentId }]
      : [];
  })[0];

  if (read.state === "loading" || (read.state === "ready" && typesPending)) {
    return (
      <SectionCard variant="flat" title={t("connected.title")}>
        <div
          role="status"
          aria-busy="true"
          aria-label={t("connected.loading")}
          className="flex flex-col gap-2"
        >
          <div className="h-4 w-1/3 rounded bg-foreground/[0.07] shimmer-pulse" />
          <div className="h-4 w-2/3 rounded bg-foreground/[0.07] shimmer-pulse" />
          <div className="h-4 w-1/2 rounded bg-foreground/[0.07] shimmer-pulse" />
        </div>
      </SectionCard>
    );
  }
  if (read.state === "failed") {
    return (
      <SectionCard variant="flat" title={t("connected.title")}>
        <ResourceRowError
          message={t("connected.failed")}
          onRetry={() => void graph.refetch()}
        />
      </SectionCard>
    );
  }

  if (grouped.groups.length === 0) {
    // Provenance (made from, in a session) is not a tie, but it is not
    // "nothing" either: never claim nothing is connected over it.
    if (grouped.provenance.all.length > 0) return null;
    const suggestions = suggestWireConnections(kind, definitions);
    if (suggestions.length === 0) return null;
    return (
      <SectionCard variant="flat" title={t("connected.title")}>
        <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-foreground/65">
          <span>{t("connected.empty")}</span>
          {suggestions.map((s) => (
            <Chip
              key={`${s.targetKind}:${s.relationType ?? ""}`}
              size="sm"
              variant="flat"
              className="text-foreground/65"
            >
              {s.label}
            </Chip>
          ))}
          <OpenInAppLink type="entity" id={entityId} />
        </div>
      </SectionCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionCard variant="flat" title={t("connected.title")}>
        <div className="flex flex-col gap-4">
          {grouped.groups.map((group) => (
            <Group
              key={group.key}
              group={group}
              hiddenIds={hiddenIds}
              previews={previews}
            />
          ))}
        </div>
      </SectionCard>
      {page && (
        <ConnectedPage
          documentId={page.documentId}
          title={page.item.name.trim() || t("connected.untitled")}
        />
      )}
    </div>
  );
}
