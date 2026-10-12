"use client";

/**
 * `ObjectPage` — one object, the one way: header, facts, the body (or tabs,
 * the active one in `?tab=`), then Advanced and the danger zone, both last
 * and collapsed. Container-agnostic on purpose: a console page renders it on
 * the page; an `/open` receiver renders it inside `ReceiverShell`'s card.
 *
 * Pages that need a different order are asking for a different page; extend
 * this rather than re-assembling the parts by hand, so every object in the
 * console reads the same top to bottom.
 */

import { Suspense, type ReactNode } from "react";
import { UrlTabs, type UrlTab } from "../../(admin)/components/url-tabs";
import { AdvancedPanel, type AdvancedId } from "./advanced-panel";
import { DangerZone, type DangerAction } from "./danger-zone";
import { FactsGrid, type Fact } from "./facts-grid";
import { ObjectHeader, type ObjectHeaderProps } from "./object-header";

/** The query param an object page's tabs live in. */
export const OBJECT_TAB_PARAM = "tab";

export interface ObjectPageProps {
  header: ObjectHeaderProps;
  facts?: Fact[];
  /** Columns for the facts grid at desktop width (2 on a phone). */
  factColumns?: 2 | 3 | 4;
  /** The body when the page has no tabs; above the tabs when it has them. */
  children?: ReactNode;
  /** First tab is the default (no param). Omit for a single-body page. */
  tabs?: UrlTab[];
  advanced?: {
    ids: AdvancedId[];
    raw?: unknown;
    explanation?: ReactNode;
  };
  danger?: DangerAction[];
}

export function ObjectPage({
  header,
  facts,
  factColumns,
  children,
  tabs,
  advanced,
  danger,
}: ObjectPageProps) {
  return (
    <div className="flex flex-col gap-6">
      <ObjectHeader {...header} />
      {facts && facts.length > 0 && (
        <FactsGrid facts={facts} columns={factColumns} />
      )}
      {children}
      {tabs && tabs.length > 0 && (
        // `UrlTabs` reads `useSearchParams`, which must sit under Suspense;
        // the default tab is what the reader would see first anyway.
        <Suspense fallback={tabs[0]!.content}>
          <UrlTabs
            param={OBJECT_TAB_PARAM}
            ariaLabel={`${header.title} sections`}
            tabs={tabs}
          />
        </Suspense>
      )}
      {(advanced || (danger && danger.length > 0)) && (
        <div className="flex flex-col gap-1 border-t border-foreground/[0.06] pt-2">
          {advanced && <AdvancedPanel {...advanced} />}
          {danger && <DangerZone actions={danger} />}
        </div>
      )}
    </div>
  );
}
