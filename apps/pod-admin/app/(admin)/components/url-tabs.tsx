"use client";

import { Tab, Tabs } from "@heroui/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

export interface UrlTab {
  key: string;
  label: string;
  content: ReactNode;
}

/**
 * Underlined tab strip whose active tab lives in a URL query param, so deep
 * links (`?section=queue`) land on the right tab. The first tab is the default
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const defaultKey = tabs[0].key;
  const raw = searchParams.get(param);
  const active = tabs.find((t) => t.key === raw)?.key ?? defaultKey;

  function setActive(next: string | number) {
    const value = String(next);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (value === defaultKey) params.delete(param);
    else params.set(param, value);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
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
          "text-foreground/55 group-data-[selected=true]:text-foreground text-[12.5px] font-medium",
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
