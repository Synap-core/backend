"use client";

/**
 * "How do you like to review?" — the one onboarding step pod-admin has
 * (founder B-4). Drawn by Review itself, in its own place, the first time a
 * person with items waiting opens it and has never chosen: three presets on
 * one side, a live preview of THEIR waiting items on the other, one button.
 * A page in the console's grammar (PageHeader, SectionCard, HeroUI Radio),
 * not a wizard. The model is `review-onboarding-model.ts`.
 */

import { useState } from "react";
import { Button, Chip, Radio, RadioGroup } from "@heroui/react";
import type { ReviewGroupBy } from "@synap-core/types/proposals/review-package";
import { PageHeader } from "../../components/page-header";
import { SectionCard } from "../../components/section-card";
import {
  ONBOARDING_PRESETS,
  onboardingPreview,
} from "./review-onboarding-model";
import { itemCount, type ReviewRow } from "./review-rows";

export function ReviewOnboarding({
  rows,
  saving,
  onChoose,
}: {
  rows: readonly ReviewRow[];
  saving: boolean;
  onChoose: (groupBy: ReviewGroupBy) => void;
}) {
  const [picked, setPicked] = useState<ReviewGroupBy>("package");
  const preset =
    ONBOARDING_PRESETS.find((p) => p.groupBy === picked) ??
    ONBOARDING_PRESETS[0]!;
  const waiting = itemCount(rows);
  const lines = onboardingPreview(rows, picked);
  return (
    <>
      <PageHeader
        title="How do you like to review?"
        description={`Your agents ask before they change things. Pick how those asks are laid out — each choice shows your own ${waiting} waiting. You can change it any time in Settings › Review.`}
      />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="lg:w-[340px] lg:shrink-0">
          <RadioGroup
            aria-label="How Review is laid out"
            value={picked}
            isDisabled={saving}
            onValueChange={(v) => setPicked(v as ReviewGroupBy)}
          >
            {ONBOARDING_PRESETS.map((p) => (
              <Radio
                key={p.groupBy}
                value={p.groupBy}
                description={p.description}
              >
                <span className="flex items-center gap-2">
                  {p.name}
                  <Chip size="sm" radius="sm" variant="flat">
                    {p.badge}
                  </Chip>
                </span>
              </Radio>
            ))}
          </RadioGroup>
        </div>
        <div className="min-w-0 flex-1">
          <SectionCard
            title={preset.name}
            hint={`Your ${waiting} waiting items`}
          >
            <ul
              aria-label="Preview with your items"
              className="-mx-2 divide-y divide-foreground/[0.05]"
            >
              {lines.map((l) => (
                <li
                  key={l.key}
                  className="flex min-h-11 items-center gap-3 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                    {l.name}
                  </span>
                  <Chip
                    size="sm"
                    radius="sm"
                    variant="flat"
                    className="tabular"
                  >
                    {l.n}
                  </Chip>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Button
          color="primary"
          isLoading={saving}
          onPress={() => onChoose(picked)}
        >
          Use this layout
        </Button>
      </div>
    </>
  );
}
