"use client";

/**
 * The document a "Create document" request would make, read as a document:
 * its first blocks drawn as markdown, then "Read the whole document", which
 * opens the full body in place (the document does not exist yet, so there is
 * nowhere else to read it). The rules live in `documentReading`
 * (`proposal-record-model.ts`); this only draws them.
 */

import { useState } from "react";
import { Button } from "@heroui/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { ContentBody } from "../../_lib/object/content/content-block";
import { documentReading } from "./proposal-record-model";

export function ProposedDocumentBody({
  content,
  defaultOpen = false,
}: {
  content: string;
  /** Start with the whole document open (the reader asked, or a test). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { preview, full, hasMore } = documentReading(content);
  const shown = open ? full : preview;
  return (
    <div data-proposed-document="" className="flex min-w-0 flex-col gap-2">
      <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/60">
        Content
      </span>
      <div
        data-proposed-document-body={open ? "whole" : "preview"}
        className="min-w-0 rounded-md bg-background/60 px-3.5 py-3 ring-1 ring-inset ring-foreground/10"
      >
        <ContentBody prepared={shown} />
        {open && full.truncated && (
          <p className="mt-2 text-[12.5px] text-foreground/65">
            Only the first {full.shownPercent}% is drawn here. The whole text is
            in Advanced, under the request.
          </p>
        )}
        {!open && hasMore && (
          <p aria-hidden className="mt-1 text-[13px] text-foreground/45">
            …
          </p>
        )}
      </div>
      {hasMore && (
        <Button
          size="sm"
          variant="light"
          aria-expanded={open}
          className="self-start px-1 text-[12.5px] text-foreground/65"
          endContent={
            open ? (
              <ChevronUp aria-hidden size={14} />
            ) : (
              <ChevronDown aria-hidden size={14} />
            )
          }
          onPress={() => setOpen((v) => !v)}
        >
          {open ? "Show less" : "Read the whole document"}
        </Button>
      )}
    </div>
  );
}
