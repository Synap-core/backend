"use client";

/**
 * A request that is not on screen: missing, not the reader's, or a read that
 * failed. Only the failed read offers Try again (`request-read-failure.ts`).
 * Shared by the request page and the Review drawer, which drew the same
 * "may have been withdrawn" line for all three before 2026-10-30.
 */

import { Button } from "@heroui/react";
import { proposalPageT } from "./copy";
import type { RequestReadFailure } from "./request-read-failure";

export function RequestUnreadable({
  failure,
  retrying,
  onRetry,
}: {
  failure: RequestReadFailure | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  const t = proposalPageT();
  if (!failure) return null;
  return (
    <div className="flex flex-col gap-3">
      <div
        role={failure.retry ? "alert" : undefined}
        className="flex flex-col gap-1"
      >
        <h2 className="font-heading text-[17px] font-medium text-foreground">
          {failure.title}
        </h2>
        <p className="text-[13px] leading-relaxed text-foreground/70">
          {failure.message}
        </p>
      </div>
      {failure.retry ? (
        <Button
          size="sm"
          variant="flat"
          radius="md"
          className="self-start"
          isLoading={retrying}
          onPress={onRetry}
        >
          {t("read.retry")}
        </Button>
      ) : null}
    </div>
  );
}
