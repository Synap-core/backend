"use client";

/**
 * WHEN THIS MOVES — the rules around one thing, on its page (plan 7d71ddcc
 * W3, decision D8: the person's word is "Rules"). ONE read:
 * `lifecycle.statusOf({ ids: [id], include: ["reactions"] })`, shaped by the
 * pure model (`../rules-around-model.ts`):
 *   1. a rule that MOVES it (a roll-up of its parts) with the parts'
 *      "3 of 5 done", first: will it move on its own, and how close is it;
 *   2. the rules its own moves set off.
 * Each names the rule (a door to its page in the Rules list), what it does,
 * and what it last did here. Empty: OMITTED. A failed read says so, with a
 * retry.
 */

import Link from "next/link";
import type { StatusOfReaction } from "@synap-core/types/units";
import { trpc } from "../../../../lib/trpc";
import { SectionCard } from "../../../(admin)/components/section-card";
import { ResourceRowError } from "../../../(admin)/components/resource-row";
import { StatusPill } from "../../../(admin)/components/status-pill";
import { useReauthOnUnauthorized } from "../use-reauth";
import { objectPage } from "../content/markdown-model";
import {
  lastOutcomeWords,
  ruleAroundHref,
  ruleAroundMark,
  rulesAroundToShow,
  type RulesAroundRead,
} from "../rules-around-model";

const TITLE = "When this moves";

export function RulesAroundSection({ thingId }: { thingId: string }) {
  const query = trpc.lifecycle.statusOf.useQuery(
    { ids: [thingId], include: ["reactions"] },
    { retry: false, staleTime: 15_000 }
  );
  useReauthOnUnauthorized(query.error);

  if (query.isLoading) return null;
  const answer = query.data?.[0] as unknown as
    { reactions?: RulesAroundRead } | undefined;
  const shown = query.error
    ? { kind: "failed" as const }
    : rulesAroundToShow(answer?.reactions);
  if (shown.kind === "none") return null;
  if (shown.kind === "failed") {
    return (
      <SectionCard variant="flat" title={TITLE}>
        <ResourceRowError
          message="The automations around it couldn’t be read."
          onRetry={() => void query.refetch()}
        />
      </SectionCard>
    );
  }
  return (
    <SectionCard variant="flat" title={TITLE}>
      <ul className="flex flex-col gap-3">
        {[...shown.movesIt, ...shown.itSetsOff].map((r) => (
          <li key={`${r.role}:${r.ruleId}`}>
            <RuleAround rule={r} />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function RuleAround({ rule }: { rule: StatusOfReaction }) {
  const mark = ruleAroundMark(rule);
  const last = lastOutcomeWords(rule);
  // Its own page says whether it still waits: the log only proves it was filed.
  const proposal = rule.last?.proposalId
    ? objectPage("proposal", rule.last.proposalId)
    : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={ruleAroundHref(rule)}
          className="min-w-0 text-[13px] text-foreground/80 underline decoration-foreground/25 underline-offset-2 [overflow-wrap:anywhere] hover:text-foreground hover:decoration-foreground"
        >
          {rule.name}
        </Link>
        {mark && <StatusPill kind={mark.kind} label={mark.label} />}
      </div>
      <p className="text-[12.5px] text-foreground/65">
        {rule.role === "moves"
          ? `It ${rule.does}.`
          : `${rule.whenWords}: ${rule.via} ${rule.does}.`}
        {last ? ` ${last.replace(/\.$/, "")}.` : ""}
        {rule.last?.outcome === "proposed" && proposal && (
          <>
            {" "}
            <Link
              href={proposal}
              className="underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground"
            >
              Open the proposal
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
