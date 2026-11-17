"use client";

/**
 * Home's Requests card: Review's count (`signals.count`) as its one door, and
 * — on a desktop — one link to Work in the desktop app. No rows: pod admin
 * runs the pod, the work is done in the apps (founder, 16 Nov 2026).
 *
 * The count has three facts and the card says each one apart: still loading
 * (a skeleton), read and zero ("Nothing waits for you."), and a read that
 * FAILED (an error with a retry), never folded into zero.
 */

import { Button } from "@heroui/react";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { navHref } from "../../../../lib/console-nav";
import { useT } from "../../../../lib/i18n/locale-provider";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { en, fr } from "./copy";

const CATALOGS = { en, fr };

/** What the card knows about the count. */
export type RequestsCount =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "empty" }
  | { kind: "waiting"; count: number; floor: boolean };

/** `signals.count`'s query → the card's state. PURE. */
export function requestsCount(query: {
  isError: boolean;
  data: { needsYou: number; truncated: boolean } | undefined;
}): RequestsCount {
  if (query.isError) return { kind: "failed" };
  if (!query.data) return { kind: "loading" };
  if (query.data.needsYou <= 0) return { kind: "empty" };
  return {
    kind: "waiting",
    count: query.data.needsYou,
    floor: query.data.truncated,
  };
}

export function RequestsCardView({
  state,
  onRetry,
  workLink,
}: {
  state: RequestsCount;
  onRetry: () => void;
  /** The link to Work in the desktop app; null on a phone. */
  workLink: ReactNode;
}) {
  const t = useT(CATALOGS);
  return (
    <SectionCard
      title={t("requests.title")}
      hint={t("requests.hint")}
      actions={
        <Button
          as={Link}
          href={navHref("review")}
          size="sm"
          variant="flat"
          radius="md"
          endContent={<ChevronRight className="h-3 w-3" />}
        >
          {state.kind !== "waiting"
            ? t("requests.open")
            : state.floor
              ? t("requests.seeAllFloor", { n: state.count })
              : t("requests.seeAll", { n: state.count })}
        </Button>
      }
    >
      {state.kind === "loading" ? (
        <ResourceRowSkeleton count={1} />
      ) : state.kind === "failed" ? (
        <ResourceRowError message={t("requests.failed")} onRetry={onRetry} />
      ) : state.kind === "empty" ? (
        <ResourceRowEmpty message={t("requests.empty")} />
      ) : null}
      {workLink && <div className="mt-2 flex justify-start">{workLink}</div>}
    </SectionCard>
  );
}
