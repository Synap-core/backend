"use client";

/**
 * One calibration pattern: "<agent> · <what happened>" as the title, how
 * often and how lately, its recent requests or objects as doors, its risk
 * as the mark's tone, and the ONE way to act (`CalibrationDecision`), drawn
 * by the page through `onAct` so the writes and their receipts live in one
 * place.
 */

import { Button } from "@heroui/react";
import { Activity } from "lucide-react";
import Link from "next/link";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { navHref } from "../../../../../lib/console-nav";
import { formatRelative } from "../../../../../lib/format";
import {
  useConsoleLocale,
  useT,
} from "../../../../../lib/i18n/locale-provider";
import { ExitLink } from "../../../../../lib/exit-link";
import { openIn } from "../../../../../lib/open-in";
import type {
  CalibrationPattern,
  CalibrationSample,
  Severity,
} from "../../../../../lib/governance-calibration/calibration-model";
import { ResourceRow } from "../../../components/resource-row";
import type { StatusKind } from "../../../components/status-pill";
import { en, fr } from "./copy";

const CATALOGS = { en, fr };

/** Risk as the mark's tone: a delete reads red, an admin act amber. */
const SEVERITY_TONE: Record<Severity, StatusKind> = {
  destructive: "down",
  admin: "stale",
  ordinary: "unknown",
};

const LINK_CLASS = "text-foreground/85 underline-offset-2 hover:underline";

/**
 * A sample as a door: a request opens its own page; an object goes through
 * the one exit door (`openIn`, placed for the device by `ExitLink`).
 */
function SampleDoor({
  sample,
  label,
}: {
  sample: CalibrationSample;
  label: string;
}) {
  if (sample.kind === "proposal")
    return (
      <Link
        href={`/proposal/${encodeURIComponent(sample.id)}`}
        className={LINK_CLASS}
      >
        {label}
      </Link>
    );
  return (
    <ExitLink
      exit={openIn({
        kind: "object",
        objectKind: sample.subjectType,
        id: sample.id,
      })}
      label={label}
    />
  );
}

/** The row's who: one agent's name, a count of several, or "An agent". */
export function usePatternWho(): (p: CalibrationPattern) => string {
  const t = useT(CATALOGS);
  return (p) =>
    p.agentName ??
    (p.agentCount > 1
      ? t("row.agents", { count: p.agentCount })
      : t("row.unknownAgent"));
}

export function PatternLine({
  pattern,
  busy,
  onAct,
}: {
  pattern: CalibrationPattern;
  busy: boolean;
  onAct: (p: CalibrationPattern) => void;
}) {
  const t = useT(CATALOGS);
  const locale = useConsoleLocale();
  const who = usePatternWho()(pattern);
  const what = pattern.phrase || t("row.ranOnItsOwn");
  const d = pattern.decision;

  const samples = pattern.samples.map((s, i) => {
    const n = pattern.samples.length > 1 ? String(i + 1) : "";
    const label =
      s.kind === "proposal"
        ? t("row.request", { n })
        : t("row.object", {
            noun: resolveObjectNoun(s.subjectType, locale),
            n,
          });
    return { key: `${s.kind}:${s.id}`, label: label.trim(), sample: s };
  });

  return (
    <div data-row-id={pattern.key} className="rounded-md transition-shadow">
      <ResourceRow
        Icon={Activity}
        primary={`${who} · ${what}`}
        secondary={
          <>
            {pattern.targetLabel && <>{pattern.targetLabel} · </>}
            {t("row.last", {
              when: formatRelative(new Date(pattern.latestAt)),
            })}
            {samples.map((s) => (
              <span key={s.key}>
                {" · "}
                <SampleDoor sample={s.sample} label={s.label} />
              </span>
            ))}
          </>
        }
        status={{
          kind: SEVERITY_TONE[pattern.severity],
          label: t("row.times", { count: pattern.count }),
        }}
        wrap
        actions={
          d === null ? undefined : d.kind === "approval" ? (
            <Button
              as={Link}
              href={navHref("approvals", { focus: d.ruleId })}
              size="sm"
              variant="flat"
              radius="md"
              className="min-h-9"
            >
              {t("act.approval")}
            </Button>
          ) : d.kind === "review-together" ? (
            <Button
              as={Link}
              href={navHref("review")}
              size="sm"
              variant="flat"
              radius="md"
              className="min-h-9"
            >
              {t("act.reviewTogether")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="flat"
              radius="md"
              className="min-h-9"
              isLoading={busy}
              aria-label={
                d.kind === "ask-first"
                  ? t("act.askFirst.aria", { who, what })
                  : undefined
              }
              onPress={() => onAct(pattern)}
            >
              {d.kind === "ask-first"
                ? t("act.askFirst")
                : t("act.markExpected")}
            </Button>
          )
        }
      />
    </div>
  );
}
