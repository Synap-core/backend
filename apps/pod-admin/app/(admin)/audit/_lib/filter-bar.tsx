"use client";

/**
 * Audit → shared filter bar.
 *
 * Sits sticky at the top of the body and feeds three sub-tabs:
 *   • Activity log    — `system.listAuditLogs` (subjectType + action + userId)
 *   • Proposals       — client-filtered `proposals.list`
 *   • Approval queue  — `proposals.list({ status: "pending" })`
 *
 * State is owned by the parent page and threaded through props so the bar
 * is one component, not three. Sub-tabs read whatever filters they care
 * about and ignore the rest.
 *
 * Date range default = last 7 days. Workspace filter is multi-select but
 * the underlying procedure (`listAuditLogs`) only takes a single workspace
 * — when more than one is selected we send `undefined` (pod-wide) and
 * filter client-side to avoid awkward UX. (TODO: extend the backend
 * procedure to take an array.)
 */

import { Button, Chip, Select, SelectItem } from "@heroui/react";
import { Filter, X } from "lucide-react";
import { useId } from "react";
import { fromLocalDateTimeInput, toLocalDateTimeInput } from "./format";

export interface AuditFilters {
  fromDate?: string; // ISO
  toDate?: string; // ISO
  /** Pod members; empty = no filter. */
  userIds: string[];
  /** Workspaces; empty = pod-wide; multi values handled client-side. */
  workspaceIds: string[];
  /** Action verbs (create/update/delete/approve/reject/...) */
  actions: string[];
  /** Subject type (workspaces/api_keys/...) — single select on the backend. */
  subjectType?: string;
}

export const DEFAULT_ACTIONS = [
  "create",
  "update",
  "delete",
  "approve",
  "reject",
  "validate",
  "grant",
  "revoke",
  "rotate",
];

export interface ActorSummary {
  id: string;
  email: string | null;
  name: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
}

export function FilterBar({
  filters,
  setFilters,
  availableSubjectTypes,
  availableActors,
  availableWorkspaces,
  isFetching,
  onReset,
}: {
  filters: AuditFilters;
  setFilters: (f: AuditFilters) => void;
  availableSubjectTypes: string[];
  availableActors: ActorSummary[];
  availableWorkspaces: WorkspaceSummary[];
  isFetching?: boolean;
  onReset: () => void;
}) {
  const fromId = useId();
  const toId = useId();

  const hasFilters =
    filters.userIds.length > 0 ||
    filters.workspaceIds.length > 0 ||
    filters.actions.length > 0 ||
    !!filters.subjectType ||
    !!filters.fromDate ||
    !!filters.toDate;

  return (
    <div
      className={[
        "sticky top-0 z-10 -mx-6 mb-5 px-6 py-3",
        "bg-background/85 backdrop-blur",
        "border-b border-foreground/[0.05]",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex items-center gap-1.5 pr-1 text-foreground/55">
          <Filter className="h-3.5 w-3.5" />
          <span className="text-[12px] font-medium">Filters</span>
        </div>

        {/* From */}
        <DateField
          id={fromId}
          label="From"
          value={toLocalDateTimeInput(filters.fromDate)}
          onChange={(v) =>
            setFilters({ ...filters, fromDate: fromLocalDateTimeInput(v) })
          }
        />
        {/* To */}
        <DateField
          id={toId}
          label="To"
          value={toLocalDateTimeInput(filters.toDate)}
          onChange={(v) =>
            setFilters({ ...filters, toDate: fromLocalDateTimeInput(v) })
          }
        />

        {/* Subject type — single select on the backend procedure. */}
        <Select
          aria-label="Subject type"
          size="sm"
          variant="bordered"
          radius="md"
          selectedKeys={filters.subjectType ? [filters.subjectType] : []}
          onSelectionChange={(keys) => {
            const k = Array.from(keys as Set<string>)[0];
            setFilters({ ...filters, subjectType: k });
          }}
          placeholder="Subject type"
          className="min-w-[160px] max-w-[200px]"
          classNames={{
            trigger:
              "h-8 min-h-8 bg-foreground/[0.04] border-foreground/10 hover:border-foreground/20 data-[hover=true]:bg-foreground/[0.06]",
            value: "text-[12px]",
          }}
        >
          {availableSubjectTypes.map((t) => (
            <SelectItem key={t}>{prettyType(t)}</SelectItem>
          ))}
        </Select>

        {/* Actions — multi */}
        <Select
          aria-label="Actions"
          size="sm"
          variant="bordered"
          radius="md"
          selectionMode="multiple"
          selectedKeys={new Set(filters.actions)}
          onSelectionChange={(keys) => {
            const arr = Array.from(keys as Set<string>);
            setFilters({ ...filters, actions: arr });
          }}
          placeholder="Actions"
          className="min-w-[160px] max-w-[260px]"
          classNames={{
            trigger:
              "h-8 min-h-8 bg-foreground/[0.04] border-foreground/10 hover:border-foreground/20 data-[hover=true]:bg-foreground/[0.06]",
            value: "text-[12px]",
          }}
          renderValue={(items) =>
            items.length === 0
              ? null
              : `${items.length} action${items.length === 1 ? "" : "s"}`
          }
        >
          {DEFAULT_ACTIONS.map((a) => (
            <SelectItem key={a}>{a}</SelectItem>
          ))}
        </Select>

        {/* Users — multi (client-side filter when > 1) */}
        <Select
          aria-label="Users"
          size="sm"
          variant="bordered"
          radius="md"
          selectionMode="multiple"
          selectedKeys={new Set(filters.userIds)}
          onSelectionChange={(keys) => {
            const arr = Array.from(keys as Set<string>);
            setFilters({ ...filters, userIds: arr });
          }}
          placeholder="Users"
          className="min-w-[160px] max-w-[240px]"
          classNames={{
            trigger:
              "h-8 min-h-8 bg-foreground/[0.04] border-foreground/10 hover:border-foreground/20 data-[hover=true]:bg-foreground/[0.06]",
            value: "text-[12px]",
          }}
          isDisabled={availableActors.length === 0}
          renderValue={(items) =>
            items.length === 0
              ? null
              : `${items.length} user${items.length === 1 ? "" : "s"}`
          }
        >
          {availableActors.map((a) => (
            <SelectItem key={a.id} textValue={a.email ?? a.name ?? a.id}>
              <span className="text-[12px]">{a.email ?? a.name ?? a.id}</span>
            </SelectItem>
          ))}
        </Select>

        {/* Workspaces — multi */}
        <Select
          aria-label="Workspaces"
          size="sm"
          variant="bordered"
          radius="md"
          selectionMode="multiple"
          selectedKeys={new Set(filters.workspaceIds)}
          onSelectionChange={(keys) => {
            const arr = Array.from(keys as Set<string>);
            setFilters({ ...filters, workspaceIds: arr });
          }}
          placeholder="Workspaces"
          className="min-w-[160px] max-w-[260px]"
          classNames={{
            trigger:
              "h-8 min-h-8 bg-foreground/[0.04] border-foreground/10 hover:border-foreground/20 data-[hover=true]:bg-foreground/[0.06]",
            value: "text-[12px]",
          }}
          isDisabled={availableWorkspaces.length === 0}
          renderValue={(items) =>
            items.length === 0
              ? null
              : `${items.length} workspace${items.length === 1 ? "" : "s"}`
          }
        >
          {availableWorkspaces.map((w) => (
            <SelectItem key={w.id} textValue={w.name}>
              <span className="text-[12px]">{w.name}</span>
            </SelectItem>
          ))}
        </Select>

        <div className="ml-auto flex items-center gap-2">
          {isFetching && (
            <Chip
              size="sm"
              variant="flat"
              radius="sm"
              className="bg-foreground/[0.06] text-[11px] text-foreground/55"
            >
              Refreshing…
            </Chip>
          )}
          {hasFilters && (
            <Button
              size="sm"
              variant="light"
              radius="md"
              onPress={onReset}
              startContent={<X className="h-3 w-3" />}
              className="text-foreground/55"
            >
              Reset
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function DateField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex flex-col gap-0.5 text-[10.5px] font-medium uppercase tracking-wide text-foreground/45"
    >
      {label}
      <input
        id={id}
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={[
          "h-8 rounded-md px-2 text-[12px] text-foreground",
          "bg-foreground/[0.04] outline-none",
          "ring-1 ring-inset ring-foreground/10",
          "hover:bg-foreground/[0.06] hover:ring-foreground/20",
          "focus:ring-primary/40",
        ].join(" ")}
      />
    </label>
  );
}

function prettyType(t: string): string {
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
