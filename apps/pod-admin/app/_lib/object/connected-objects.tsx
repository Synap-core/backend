"use client";

/**
 * "Connected": the objects this one is wired to, drawn the way each reads best
 * (`connected-model`). A brand asset keeps its HTML source and its renders as
 * related files, not as words in its description: this is where they show.
 *
 *   · an image: a thumbnail through the one media door, captioned with a door
 *     to its own page;
 *   · a stored HTML file: its page in the isolated frame (`DocumentContentSection`,
 *     the same path a body document takes), a few at a time;
 *   · anything else: a door to its page, capped, with "Show all".
 *
 * It reads `relations.getRelated` on the viewer's own floor. A failed read says
 * so and offers "Try again": it never looks like "nothing connected". With
 * nothing connected the section is omitted.
 */

import { useState } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import { trpc } from "../../../lib/trpc";
import { ResourceRowError } from "../../(admin)/components/resource-row";
import { SectionCard } from "../../(admin)/components/section-card";
import { openT } from "../../open/copy";
import { kindIcon, kindLabel } from "./kind-icon";
import { MediaView } from "../media/media-view";
import { DocumentContentSection } from "./content/content-block";
import { useDocumentContent } from "./content/use-document-content";
import {
  connectedGroups,
  hasConnected,
  type ConnectedEntity,
  type ConnectedItem,
} from "./connected-model";

/** Pages drawn in their frame before "Show all"; others listed before it. */
const PAGES_SHOWN = 1;
const OTHERS_SHOWN = 6;

const DOOR =
  "inline-flex min-w-0 items-center gap-1.5 rounded-sm text-[13px] text-foreground/80 underline decoration-foreground/25 underline-offset-2 hover:text-foreground hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

const openHref = (id: string) => `/open/entity/${encodeURIComponent(id)}`;

function ConnectedPage({ item }: { item: ConnectedItem }) {
  const body = useDocumentContent(item.documentId);
  const t = openT();
  return (
    <DocumentContentSection
      title={item.title ?? t("connected.untitled")}
      content={body.content}
      onRetry={body.retry}
    />
  );
}

export function ConnectedObjects({ entityId }: { entityId: string }) {
  const t = openT();
  const query = trpc.relations.getRelated.useQuery(
    { entityId, direction: "both", limit: 50 },
    { retry: false }
  );
  const [allPages, setAllPages] = useState(false);
  const [allOthers, setAllOthers] = useState(false);

  if (query.isLoading) return null;
  if (query.error) {
    return (
      <SectionCard variant="flat" title={t("connected.title")}>
        <ResourceRowError
          message={t("connected.failed")}
          onRetry={() => void query.refetch()}
        />
      </SectionCard>
    );
  }
  const groups = connectedGroups(
    (query.data?.entities ?? []) as ConnectedEntity[],
    entityId
  );
  if (!hasConnected(groups)) return null;

  const pages = allPages ? groups.pages : groups.pages.slice(0, PAGES_SHOWN);
  const others = allOthers
    ? groups.others
    : groups.others.slice(0, OTHERS_SHOWN);

  return (
    <section aria-label={t("connected.title")} className="flex flex-col gap-4">
      {pages.map((item) => (
        <ConnectedPage key={item.id} item={item} />
      ))}
      {groups.pages.length > PAGES_SHOWN && (
        <Button
          size="sm"
          variant="light"
          radius="md"
          className="self-start"
          onPress={() => setAllPages((v) => !v)}
        >
          {allPages
            ? t("connected.showLess")
            : t("connected.showAll", { n: groups.pages.length })}
        </Button>
      )}
      {groups.images.length > 0 && (
        <SectionCard variant="flat" title={t("connected.pages")}>
          <ul className="flex flex-wrap items-start gap-4">
            {groups.images.map((item) => (
              <li key={item.id} className="flex min-w-0 flex-col gap-1.5">
                <MediaView
                  media={{
                    via: "stored",
                    documentId: item.documentId!,
                    ...(item.mime ? { mime: item.mime } : {}),
                  }}
                  alt={item.title ?? t("connected.untitled")}
                  size="thumb"
                  viaEntityId={item.id}
                />
                <Link href={openHref(item.id)} className={DOOR}>
                  {item.title ?? t("connected.untitled")}
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
      {groups.others.length > 0 && (
        <SectionCard variant="flat" title={t("connected.title")}>
          <ul className="flex flex-col gap-1.5">
            {others.map((item) => {
              const Icon = kindIcon(item.kind);
              return (
                <li key={item.id} className="flex min-w-0 items-center gap-2">
                  <Icon
                    aria-hidden
                    className="h-4 w-4 shrink-0 text-foreground/50"
                  />
                  <Link href={openHref(item.id)} className={DOOR}>
                    {item.title ?? t("connected.untitled")}
                  </Link>
                  <span className="shrink-0 text-[12px] text-foreground/50">
                    {kindLabel(item.kind)}
                  </span>
                </li>
              );
            })}
          </ul>
          {groups.others.length > OTHERS_SHOWN && (
            <Button
              size="sm"
              variant="light"
              radius="md"
              className="mt-2 self-start"
              onPress={() => setAllOthers((v) => !v)}
            >
              {allOthers
                ? t("connected.showLess")
                : t("connected.showAll", { n: groups.others.length })}
            </Button>
          )}
        </SectionCard>
      )}
    </section>
  );
}
