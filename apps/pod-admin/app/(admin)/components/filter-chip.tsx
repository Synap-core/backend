"use client";

/**
 * The filter of a console list (page-grammar §9, decision afab5911): ONE chip
 * per filter that shows its current value ("All computers", "Failing 3") and
 * opens a menu with the values, the current one checked. A set chip carries a
 * × back to the filter's default. `FilterRow` holds the page's whole control
 * set on one row: search, the filter chips, then tabs or the view switch,
 * then the primary.
 *
 * Never draw a filter as a row of pressed chips (one per value): that is what
 * this replaced, and `__tripwires__/one-chip-per-filter.test.ts` fails on it.
 * A choice that is NOT a filter (a grouping, a layout, a setting) is a
 * `SegmentedChoice`.
 *
 * With `param`, the value lives in the address so a link lands on it (pod
 * admin's pages are client pages; this is the `hrefFor` of the server-rendered
 * stacks). The default is encoded by omitting the param.
 */

import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger,
} from "@heroui/react";
import { ChevronDown, X } from "lucide-react";
import type { ReactNode } from "react";
import { useReplaceParams } from "../../../lib/use-replace-params";
import {
  filterChipFace,
  filterMenuItems,
  filterSelectedKeys,
  filterSelectionFromKeys,
  writeFilterParam,
  type FilterOption,
} from "./filter-chip-model";

export type { FilterOption } from "./filter-chip-model";

interface CommonProps<K extends string> {
  /** The filter's name ("Status", "Source"): the menu's heading and the chip's accessible name. */
  label: string;
  /** The values, from the data. */
  options: readonly FilterOption<K>[];
  /**
   * The neutral word when nothing is chosen. Default "All". `null` = the
   * filter has no "All": a value is always chosen (single only).
   */
  allLabel?: string | null;
  /** The count for "All", when the page measured it. */
  allCount?: number | string | null;
  /** Show the current value's count on the chip. Default on. */
  showCount?: boolean;
  /** A set chip carries a × back to the default. Default on. */
  clearable?: boolean;
  /** Bind the value to this URL query param. */
  param?: string;
  /** The chip's text for several chosen values. */
  manyLabel?: (count: number) => string;
}

interface SingleProps<K extends string> extends CommonProps<K> {
  selectionMode?: "single";
  value: K | null;
  /** What the filter opens on (omitting `param` lands on it; × goes back to it). Default: All. */
  defaultValue?: K | null;
  /** Runs on every pick, after the URL is written (when bound). */
  onChange?: (next: K | null) => void;
}

interface MultipleProps<K extends string> extends CommonProps<K> {
  selectionMode: "multiple";
  values: readonly K[];
  onValuesChange?: (next: K[]) => void;
}

export type FilterChipProps<K extends string> =
  SingleProps<K> | MultipleProps<K>;

export function FilterChip<K extends string>(props: FilterChipProps<K>) {
  const {
    label,
    options,
    allCount,
    showCount = true,
    clearable = true,
    param,
    manyLabel,
  } = props;
  const replaceParams = useReplaceParams();
  const multiple = props.selectionMode === "multiple";
  const mode = multiple ? "multiple" : "single";
  // A multiple filter always has an "All": its empty selection.
  const allLabel =
    props.allLabel === undefined || multiple
      ? (props.allLabel ?? "All")
      : props.allLabel;

  const selected: string[] =
    props.selectionMode === "multiple"
      ? [...props.values]
      : props.value === null
        ? []
        : [props.value];
  const defaultSelected: string[] =
    props.selectionMode !== "multiple" && props.defaultValue != null
      ? [props.defaultValue]
      : [];

  const face = filterChipFace({
    options,
    selected,
    allLabel,
    defaultSelected,
    manyLabel,
    showCount,
    allCount,
  });
  const items = filterMenuItems({ options, mode, allLabel, allCount });

  function commit(next: string[]) {
    if (param !== undefined)
      replaceParams((params) =>
        writeFilterParam(params, param, next, defaultSelected)
      );
    if (props.selectionMode === "multiple") props.onValuesChange?.(next as K[]);
    else props.onChange?.((next[0] ?? null) as K | null);
  }

  const spoken =
    face.count === null ? face.text : `${face.text} (${face.count})`;

  return (
    <div
      className={[
        "inline-flex shrink-0 items-center rounded-md ring-1 ring-inset transition-colors",
        face.isSet
          ? "bg-foreground/[0.08] ring-foreground/15"
          : "ring-foreground/10 hover:bg-content2/50",
      ].join(" ")}
    >
      <Dropdown placement="bottom-start">
        <DropdownTrigger>
          <Button
            size="sm"
            variant="light"
            radius="md"
            disableRipple
            aria-label={`${label}: ${spoken}`}
            className="h-8 min-w-0 gap-1.5 bg-transparent px-2.5 text-[12.5px] font-medium tracking-tight data-[hover=true]:bg-transparent"
            endContent={
              <ChevronDown
                className="h-3.5 w-3.5 text-foreground/55"
                aria-hidden
              />
            }
          >
            <span
              className={face.isSet ? "text-foreground" : "text-foreground/75"}
            >
              {face.text}
            </span>
            {face.count !== null && (
              <span className="tabular text-[11px] text-foreground/65">
                {face.count}
              </span>
            )}
          </Button>
        </DropdownTrigger>
        <DropdownMenu
          aria-label={label}
          selectionMode={mode}
          selectedKeys={new Set(filterSelectedKeys(mode, selected))}
          disallowEmptySelection={!multiple}
          closeOnSelect={!multiple}
          disabledKeys={items.filter((i) => i.disabled).map((i) => i.id)}
          onSelectionChange={(keys) =>
            commit(
              filterSelectionFromKeys(
                mode,
                keys === "all"
                  ? new Set(items.map((i) => i.id))
                  : new Set([...keys].map(String)),
                options
              )
            )
          }
        >
          <DropdownSection title={label}>
            {items.map((item) => (
              <DropdownItem
                key={item.id}
                textValue={item.label}
                description={item.description}
                endContent={
                  item.count === null ? null : (
                    <span className="tabular text-[11px] text-foreground/55">
                      {item.count}
                    </span>
                  )
                }
              >
                {item.label}
              </DropdownItem>
            ))}
          </DropdownSection>
        </DropdownMenu>
      </Dropdown>
      {clearable && face.isSet && (
        <button
          type="button"
          aria-label={`Clear ${label}`}
          onClick={() => commit(defaultSelected)}
          className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

/**
 * One row for a list's whole control set, in this order: search, one chip
 * per filter, the tabs or view switch, the primary. Never a second row of
 * chips. On a narrow screen the row scrolls sideways instead of wrapping.
 */
export function FilterRow({
  search,
  filters,
  tabs,
  primary,
  className = "mb-4",
}: {
  search?: ReactNode;
  filters?: ReactNode;
  tabs?: ReactNode;
  primary?: ReactNode;
  /** Spacing around the row; a list's filter row sits `mb-4` above it. */
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="-mx-0.5 -my-1 flex items-center gap-2 overflow-x-auto px-0.5 py-1">
        {search && (
          <div className="min-w-[10rem] max-w-md flex-1">{search}</div>
        )}
        {filters}
        {tabs && <div className="shrink-0">{tabs}</div>}
        {primary && <div className="ml-auto shrink-0">{primary}</div>}
      </div>
    </div>
  );
}
