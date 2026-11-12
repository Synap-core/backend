"use client";

/**
 * An HTML page drawn INSIDE another surface — a proposal's card, a document
 * a request would create — rather than as an object page of its own. It is
 * the one frame (`html-frame`) with the same Page / Source toggle and Full
 * size, minus the section shell.
 *
 * It answers NO pod reads (`bridge={false}`): what a proposal brings has not
 * been approved, so its script may draw but never reads the viewer's pod.
 * Once approved, the stored page runs with its bridge on its own page.
 */

import { Button, Tab, Tabs } from "@heroui/react";
import { Maximize2 } from "lucide-react";
import {
  CELL_FRAME_MAX_BYTES,
  htmlByteLength,
} from "@synap-core/types/cell-bridge";
import { useMemo, useState } from "react";
import { prepareContent } from "./markdown-model";
import { ContentBody } from "./content-block";
import { frameT } from "./frame-copy";
import { HtmlPageBody, useFullSize, type HtmlPageView } from "./html-frame";

export function HtmlPagePreview({
  html,
  title,
  workspaceId = null,
}: {
  html: string;
  title: string;
  /** The space the page will live in, when known. */
  workspaceId?: string | null;
}) {
  const t = frameT();
  const [view, setView] = useState<HtmlPageView>("page");
  const fullSize = useFullSize();
  const bytes = useMemo(() => htmlByteLength(html), [html]);
  const tooLarge = bytes > CELL_FRAME_MAX_BYTES;
  const source = useMemo(() => prepareContent(html, "source"), [html]);
  return (
    <div
      data-html-preview=""
      className="flex min-w-0 flex-col gap-2 rounded-md bg-background/60 p-2 ring-1 ring-inset ring-foreground/10"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-foreground/60">{t("preview.note")}</p>
        <div className="flex items-center gap-2">
          {view === "page" && !tooLarge && (
            <Button
              size="sm"
              variant="light"
              radius="md"
              startContent={<Maximize2 aria-hidden size={14} />}
              onPress={fullSize.enter}
            >
              {t("fullSize")}
            </Button>
          )}
          <Tabs
            size="sm"
            aria-label={t("toggle.aria")}
            selectedKey={view}
            onSelectionChange={(key) => setView(key as HtmlPageView)}
            classNames={{
              tabList: "bg-foreground/[0.04] rounded-lg",
              tab: "text-[12px]",
            }}
          >
            <Tab key="page" title={t("toggle.page")} />
            <Tab key="source" title={t("toggle.source")} />
          </Tabs>
        </div>
      </div>
      <HtmlPageBody
        view={view}
        html={html}
        bytes={bytes}
        tooLarge={tooLarge}
        workspaceId={workspaceId}
        source={source}
        title={title}
        sourceBody={(prepared) => <ContentBody prepared={prepared} />}
        onShowSource={() => setView("source")}
        fullSize={fullSize}
        bridge={false}
      />
    </div>
  );
}
