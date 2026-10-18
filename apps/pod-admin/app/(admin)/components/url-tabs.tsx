"use client";

import { Tab, Tabs } from "@heroui/react";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useReplaceParams } from "../../../lib/use-replace-params";

export interface UrlTab {
  key: string;
  label: string;
  content: ReactNode;
}

/**
 * Underlined tab strip whose active tab lives in a URL query param, so deep
 * links (`?tab=installed`) land on the right tab. The first tab is the default
 * and is encoded by omitting the param. Other params (`?focus=`) survive a
 * switch, and the history entry is replaced: a tab is a view of the page, not
 * a place to go back to. Must sit under a Suspense boundary
 * (`useSearchParams`).
 */
export function UrlTabs({
  param,
  ariaLabel,
  tabs,
}: {
  param: string;
  ariaLabel: string;
  tabs: UrlTab[];
}) {
  const searchParams = useSearchParams();
  const replaceParams = useReplaceParams();
  const defaultKey = tabs[0].key;
  const raw = searchParams.get(param);
  const active = tabs.find((t) => t.key === raw)?.key ?? defaultKey;

  function setActive(next: string | number) {
    const value = String(next);
    replaceParams((params) => {
      if (value === defaultKey) params.delete(param);
      else params.set(param, value);
    });
  }

  return (
    <Tabs
      aria-label={ariaLabel}
      variant="underlined"
      selectedKey={active}
      onSelectionChange={setActive}
      classNames={{
        tabList: "gap-4 px-0 border-b border-foreground/[0.05] rounded-none",
        tab: "px-1 h-10",
        cursor: "bg-primary",
        tabContent:
          "text-foreground/65 group-data-[selected=true]:text-foreground text-[12.5px] font-medium",
      }}
    >
      {tabs.map((t) => (
        <Tab key={t.key} title={t.label}>
          <div className="pt-5">{t.content}</div>
        </Tab>
      ))}
    </Tabs>
  );
}
