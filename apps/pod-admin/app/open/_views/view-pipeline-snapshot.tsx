"use client";

/**
 * A pipeline view's read-only snapshot, drawn from `flow.of`: each declared
 * state in its own order with its exact count, how many are stuck, and the
 * first few things as doors to their pages. It is a summary, not the view:
 * moving a card and filtering happen in the Synap app (the hand-off under it
 * says so). A failed read says it failed and offers a retry; it is never drawn
 * as an empty pipeline.
 */

import Link from "next/link";
import { Fragment } from "react";
import { trpc } from "../../../lib/trpc";
import { SectionCard } from "../../(admin)/components/section-card";
import { ResourceRowError } from "../../(admin)/components/resource-row";
import { objectPage } from "../../_lib/object/content/markdown-model";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import { openT } from "../copy";
import {
  SNAPSHOT_CARD_CAP,
  pipelineSnapshot,
  type FlowLike,
} from "./view-pipeline-model";

const DOOR =
  "underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-sm";

export function ViewPipelineSnapshot({
  kind,
  workspaceId,
}: {
  kind: string;
  workspaceId: string | null;
}) {
  const t = openT();
  const query = trpc.flow.of.useQuery({
    profileSlug: kind,
    workspaceId,
    firstN: SNAPSHOT_CARD_CAP,
  });
  useReauthOnUnauthorized(query.error);

  const flow = query.data as FlowLike | undefined;
  const snapshot = flow ? pipelineSnapshot(flow) : null;

  return (
    <SectionCard variant="flat" title={t("view.snapshot.title")}>
      {query.isLoading ? (
        <div
          role="status"
          aria-busy="true"
          aria-label={t("view.snapshot.loading")}
          className="flex max-w-[65ch] flex-col gap-2"
        >
          <div className="h-3 w-full rounded bg-foreground/[0.07] shimmer-pulse" />
          <div className="h-3 w-11/12 rounded bg-foreground/[0.07] shimmer-pulse" />
          <div className="h-3 w-2/3 rounded bg-foreground/[0.07] shimmer-pulse" />
        </div>
      ) : !snapshot ? (
        <ResourceRowError
          message={t("view.snapshot.failed")}
          onRetry={() => void query.refetch()}
        />
      ) : snapshot.empty ? (
        <p className="text-[12.5px] text-foreground/65">
          {t("view.snapshot.empty")}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-foreground/10">
            {snapshot.rows.map((row) => (
              <li key={row.key} className="flex flex-col gap-1 py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-foreground">
                    {row.label}
                    {row.windowDays !== null && (
                      <span className="text-foreground/65">
                        {" · "}
                        {t("view.snapshot.windowed", { days: row.windowDays })}
                      </span>
                    )}
                  </span>
                  <span className="text-[13px] tabular-nums text-foreground/80">
                    {row.count}
                  </span>
                </div>
                {row.stuck !== null && (
                  <span className="text-[12px] text-foreground/70">
                    {t("view.snapshot.stuck", { n: row.stuck })}
                  </span>
                )}
                {row.cards.length > 0 && (
                  <p className="text-[12.5px] text-foreground/70">
                    {row.cards.map((card, i) => {
                      const href = objectPage("entity", card.id);
                      const name =
                        card.name?.trim() || t("view.snapshot.untitled");
                      return (
                        <Fragment key={card.id}>
                          {i > 0 && " · "}
                          {href ? (
                            <Link href={href} className={DOOR}>
                              {name}
                            </Link>
                          ) : (
                            name
                          )}
                        </Fragment>
                      );
                    })}
                    {row.more > 0 && (
                      <span className="text-foreground/65">
                        {" · "}
                        {t("view.snapshot.more", { n: row.more })}
                      </span>
                    )}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-foreground/65">
            {t("view.snapshot.total", { n: snapshot.total })}
            {snapshot.unclassified > 0 && (
              <>
                {" · "}
                {t("view.snapshot.unclassified", { n: snapshot.unclassified })}
              </>
            )}
          </p>
        </>
      )}
    </SectionCard>
  );
}
