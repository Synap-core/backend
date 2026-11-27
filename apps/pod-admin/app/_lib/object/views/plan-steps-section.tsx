"use client";

/**
 * THE STEPS OF A PLAN — on a session page, the steps the session spawned,
 * each with its READINESS as a mark (a glyph, a word and a ring: planned,
 * ready, blocked, active, done, skipped, dropped), and ONE door: "Open the
 * plan in Synap", the desktop app where the flow canvas lives.
 *
 * Pod admin does not draw the canvas (decisions 94cd8636, acec8eb9: it stays
 * at the shared marks plus doors). It reads the canvas's own read
 * (`focusSessions.graph`, one wave) and asks the shared rule for each state
 * (`planSteps` → `stepReadinessOf`); the model is `../plan-steps-model.ts`.
 * A plan with no step is OMITTED; a failed read says so, with a retry.
 */

import Link from "next/link";
import {
  Circle,
  CircleCheck,
  CircleDot,
  CircleSlash,
  CircleX,
  Lock,
  Play,
  type LucideIcon,
} from "lucide-react";
import { trpc } from "../../../../lib/trpc";
import { openIn } from "../../../../lib/open-in";
import { ExitLink } from "../../../../lib/exit-link";
import { SectionCard } from "../../../(admin)/components/section-card";
import { ResourceRowError } from "../../../(admin)/components/resource-row";
import { StatusPill } from "../../../(admin)/components/status-pill";
import { useReauthOnUnauthorized } from "../use-reauth";
import {
  planSteps,
  readinessWord,
  type PlanGraph,
  type ReadinessMark,
} from "../plan-steps-model";
import { objectViewsT } from "./copy";

/** One glyph per state: a mark is never colour alone. */
const GLYPH: Record<ReadinessMark["glyph"], LucideIcon> = {
  planned: Circle,
  ready: Play,
  blocked: Lock,
  active: CircleDot,
  done: CircleCheck,
  skipped: CircleSlash,
  dropped: CircleX,
};

export function PlanStepsSection({
  sessionId,
  hrefFor,
}: {
  /** The plan's root: the session whose page this is. */
  sessionId: string;
  /** A session's page in this frame; null = none to open. */
  hrefFor: (sessionId: string) => string | null;
}) {
  const t = objectViewsT();
  // The canvas's own read, narrowed to this wave (root plus what it spawned).
  const query = trpc.focusSessions.graph.useQuery(
    { rootSessionId: sessionId, kind: "all", lens: "all" },
    { retry: false, staleTime: 15_000 }
  );
  useReauthOnUnauthorized(query.error);
  if (query.isLoading) return null;
  const title = t("plan.title");
  if (query.error) {
    return (
      <SectionCard variant="flat" title={title}>
        <ResourceRowError
          message={t("plan.failed")}
          onRetry={() => void query.refetch()}
        />
      </SectionCard>
    );
  }
  const steps = planSteps(query.data as PlanGraph | undefined, sessionId);
  if (steps.state === "none") return null;
  return (
    <SectionCard
      variant="flat"
      title={title}
      count={steps.rows.length}
      hint={steps.truncated ? t("plan.truncated") : undefined}
    >
      <ul className="flex flex-col">
        {steps.rows.map((row) => {
          const href = hrefFor(row.id);
          return (
            <li
              key={row.id}
              className="flex items-center gap-2 border-b border-foreground/[0.05] py-2 last:border-b-0"
            >
              <StatusPill
                kind={row.mark.tone}
                label={readinessWord(row.mark.state)}
                icon={GLYPH[row.mark.glyph]}
              />
              {href ? (
                <Link
                  href={href}
                  className="min-w-0 flex-1 break-words rounded-sm text-[13px] text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {row.title}
                </Link>
              ) : (
                <span className="min-w-0 flex-1 break-words text-[13px] text-foreground/85">
                  {row.title}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {steps.waitsUnread && (
        <p className="text-[12.5px] text-foreground/75" role="status">
          {t("plan.waitsUnread")}
        </p>
      )}
      <ExitLink
        exit={openIn({
          kind: "objectInApp",
          objectKind: "session",
          id: sessionId,
        })}
        label={t("plan.open")}
      />
    </SectionCard>
  );
}
