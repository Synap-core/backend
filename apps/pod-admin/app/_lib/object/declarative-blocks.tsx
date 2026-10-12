"use client";

/**
 * `DeclarativeBlocks` — draws a `declarative` renderer's schema
 * (`DeclarativeBlock[]`, `@synap-core/types/renderer-ref`) in the console's
 * own vocabulary: headings, prose, a stat grid, lists, and a button row.
 *
 * A button's `action` is a capability verb key or an app route — neither of
 * which this surface can run on its own. So buttons render only when the host
 * passes `onAction`; without it they are omitted rather than drawn dead.
 */

import { Button } from "@heroui/react";
import type { DeclarativeBlock } from "@synap-core/types/renderer-ref";
import { declarativeSegments } from "./declarative";
import { FactsGrid } from "./facts-grid";

type ButtonBlock = Extract<DeclarativeBlock, { type: "button" }>;

const HEADING_CLASS: Record<1 | 2 | 3, string> = {
  1: "font-heading text-[18px] font-medium tracking-tight text-foreground",
  2: "text-[15px] font-medium tracking-tight text-foreground",
  3: "text-[13px] font-medium text-foreground",
};

export function DeclarativeBlocks({
  blocks,
  onAction,
}: {
  blocks: readonly DeclarativeBlock[];
  onAction?: (block: ButtonBlock) => void;
}) {
  const segments = declarativeSegments(blocks);
  if (segments.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      {segments.map((segment, i) => {
        switch (segment.kind) {
          case "heading": {
            const level = segment.block.level ?? 2;
            const Tag = `h${level + 1}` as "h2" | "h3" | "h4";
            return (
              <Tag key={i} className={HEADING_CLASS[level]}>
                {segment.block.text}
              </Tag>
            );
          }
          case "text":
            return (
              <p
                key={i}
                className="whitespace-pre-line text-[13px] leading-relaxed text-foreground/80"
              >
                {segment.block.text}
              </p>
            );
          case "list": {
            const ListTag = segment.block.ordered ? "ol" : "ul";
            return (
              <ListTag
                key={i}
                className={`flex flex-col gap-1 pl-5 text-[13px] leading-relaxed text-foreground/80 ${
                  segment.block.ordered ? "list-decimal" : "list-disc"
                }`}
              >
                {segment.block.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ListTag>
            );
          }
          case "stats":
            return (
              <FactsGrid
                key={i}
                facts={segment.blocks.map((stat) => ({
                  label: stat.label,
                  value: stat.hint ? (
                    <span className="flex flex-col">
                      <span className="tabular text-[15px] text-foreground">
                        {stat.value}
                      </span>
                      <span className="text-[11.5px] text-foreground/65">
                        {stat.hint}
                      </span>
                    </span>
                  ) : (
                    <span className="tabular text-[15px] text-foreground">
                      {stat.value}
                    </span>
                  ),
                }))}
              />
            );
          case "buttons":
            if (!onAction) return null;
            return (
              <div key={i} className="flex flex-wrap gap-2">
                {segment.blocks.map((button, j) => (
                  <Button
                    key={`${button.action}-${j}`}
                    size="sm"
                    radius="md"
                    variant={j === 0 ? "solid" : "flat"}
                    color={j === 0 ? "primary" : "default"}
                    onPress={() => onAction(button)}
                  >
                    {button.label}
                  </Button>
                ))}
              </div>
            );
        }
      })}
    </div>
  );
}
