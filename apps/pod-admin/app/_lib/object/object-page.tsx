"use client";

/**
 * `ObjectPage` — one object, the one way: header, facts, the body (or tabs,
 * the active one in `?tab=`), then Advanced and the danger zone, both last
 * and collapsed. A page with a `rail` draws its body beside it, and the
 * facts move to the rail's foot. Container-agnostic on purpose: a console page renders it on
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
  /**
   * The standing sections read BESIDE the body (page grammar: column + rail):
   * at desktop width a column on the right, the facts at its foot; on a phone
   * it follows the body. A page with a rail draws wide in either frame
   * (`consoleWidth`, `openWidth`). Omit for a single-column page.
   */
  rail?: ReactNode;
  /** The rail's accessible name. */
  railLabel?: string;
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
  rail,
  railLabel = "Details",
  advanced,
  danger,
}: ObjectPageProps) {
  const hasFacts = Boolean(facts && facts.length > 0);
  const body = (
    <>
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
    </>
  );
  return (
    <div className="flex flex-col gap-6">
      <ObjectHeader {...header} />
      {rail ? (
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
          <div className="flex min-w-0 flex-1 flex-col gap-6">{body}</div>
          <aside
            aria-label={railLabel}
            className="flex w-full min-w-0 flex-col gap-6 border-t border-foreground/[0.06] pt-6 lg:w-[300px] lg:shrink-0 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0 xl:w-[320px]"
          >
            {rail}
            {hasFacts && <FactsGrid facts={facts!} columns={2} />}
          </aside>
        </div>
      ) : (
        <>
          {hasFacts && <FactsGrid facts={facts!} columns={factColumns} />}
          {body}
        </>
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
