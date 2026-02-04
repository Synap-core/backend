/**
 * View Default Columns Service
 *
 * Computes default columns for views based on scope profiles.
 * Implements conservative defaults per view type.
 */

import type { MergedProperty } from "./property-merging-service.js";

/**
 * Column definition for views
 */
export interface ViewColumn {
  id: string;
  field: string; // 'title' | 'properties.status' | etc.
  title?: string;
  valueType?: string;
  indexed?: boolean;
  visible?: boolean;
  width?: number;
}

/**
 * Compute default columns for a view type
 */
export class ViewDefaultColumnsService {
  /**
   * Compute default columns for table view
   * Conservative: title + profile + few common/indexed properties
   */
  computeTableColumns(
    allProperties: Map<string, MergedProperty>,
    scopeProfileCount: number
  ): ViewColumn[] {
    // Core columns (always shown)
    const defaults: ViewColumn[] = [
      { id: "title", field: "title", title: "Title", visible: true },
      {
        id: "profile",
        field: "profile",
        title: "Type",
        visible: true,
      }, // Show which profile
    ];

    // Add common properties (exist in ALL scope profiles)
    const commonProperties = Array.from(allProperties.values())
      .filter(
        (prop) => prop.profiles.length === scopeProfileCount // ✅ FIX: Compare against scopeProfileCount
      )
      .filter((prop) => prop.indexed) // Only indexed
      .slice(0, 6); // Max 6 additional columns

    const propertyColumns = commonProperties.map((prop) => ({
      id: prop.slug,
      field: `properties.${prop.slug}`,
      title: (prop.uiHints?.displayName as string) || prop.slug,
      valueType: prop.valueType,
      indexed: prop.indexed,
      visible: true,
    }));

    return [...defaults, ...propertyColumns];
  }

  /**
   * Compute default columns for kanban view
   * Returns groupBy candidate (first enum/string property)
   */
  computeKanbanColumns(
    allProperties: Map<string, MergedProperty>,
    scopeProfileCount: number
  ): ViewColumn[] {
    // Kanban doesn't use columns, but needs groupBy field
    // Auto-detect first enum/string property that's indexed and common
    const groupByCandidate = Array.from(allProperties.values())
      .filter((prop) => prop.profiles.length === scopeProfileCount)
      .filter((prop) => prop.valueType === "string" && prop.indexed)
      .find((prop) => prop.slug); // First match

    if (groupByCandidate) {
      return [
        {
          id: groupByCandidate.slug,
          field: `properties.${groupByCandidate.slug}`,
          title:
            (groupByCandidate.uiHints?.displayName as string) ||
            groupByCandidate.slug,
          valueType: groupByCandidate.valueType,
          indexed: groupByCandidate.indexed,
        },
      ];
    }

    return [];
  }

  /**
   * Compute default columns for list/grid/gallery view
   */
  computeListColumns(
    allProperties: Map<string, MergedProperty>,
    scopeProfileCount: number
  ): ViewColumn[] {
    // Similar to table, but fewer columns
    const defaults: ViewColumn[] = [
      { id: "title", field: "title", title: "Title", visible: true },
    ];

    const commonProperties = Array.from(allProperties.values())
      .filter((prop) => prop.profiles.length === scopeProfileCount)
      .filter((prop) => prop.indexed)
      .slice(0, 4); // Max 4 additional columns

    const propertyColumns = commonProperties.map((prop) => ({
      id: prop.slug,
      field: `properties.${prop.slug}`,
      title: (prop.uiHints?.displayName as string) || prop.slug,
      valueType: prop.valueType,
      indexed: prop.indexed,
      visible: true,
    }));

    return [...defaults, ...propertyColumns];
  }

  /**
   * Apply column overrides from view config
   */
  applyColumnOverrides(
    defaultColumns: ViewColumn[],
    config: {
      hiddenColumns?: string[];
      visibleColumns?: string[];
      columnOrder?: string[];
      columnWidths?: Record<string, number>;
    }
  ): ViewColumn[] {
    let columns = [...defaultColumns];

    // Apply visibleColumns (if set, overrides defaults)
    if (config.visibleColumns && config.visibleColumns.length > 0) {
      const columnMap = new Map(columns.map((c) => [c.id, c]));
      columns = config.visibleColumns
        .map((id) => columnMap.get(id))
        .filter((c): c is ViewColumn => c !== undefined);
    }

    // Apply hiddenColumns
    if (config.hiddenColumns && config.hiddenColumns.length > 0) {
      const hiddenSet = new Set(config.hiddenColumns);
      columns = columns.filter((c) => !hiddenSet.has(c.id));
    }

    // Apply columnOrder
    if (config.columnOrder && config.columnOrder.length > 0) {
      const orderMap = new Map(
        config.columnOrder.map((id, index) => [id, index])
      );
      const ordered = columns.sort((a, b) => {
        const aOrder = orderMap.get(a.id) ?? Infinity;
        const bOrder = orderMap.get(b.id) ?? Infinity;
        return aOrder - bOrder;
      });

      // Keep ordered columns first, then append any not in order
      const orderedIds = new Set(config.columnOrder);
      const orderedColumns = ordered.filter((c) => orderedIds.has(c.id));
      const unorderedColumns = ordered.filter((c) => !orderedIds.has(c.id));
      columns = [...orderedColumns, ...unorderedColumns];
    }

    // Apply columnWidths
    if (config.columnWidths) {
      columns = columns.map((c) => ({
        ...c,
        width: config.columnWidths![c.id] ?? c.width,
      }));
    }

    return columns;
  }

  /**
   * Get default render config for view type
   */
  getDefaultRenderConfig(viewType: string): Record<string, unknown> {
    const defaults: Record<string, Record<string, unknown>> = {
      table: {
        showAllColumns: false, // Conservative default
        columnOrder: "profile-order",
        columnWidth: "auto",
        rowHeight: "default",
        showRelations: false,
      },
      kanban: {
        groupBy: "first-enum-property", // Auto-detect
        cardFields: ["title", "status", "dueDate"], // First 3 properties
        showWIPLimit: false,
        cardHeight: "auto",
      },
      graph: {
        layout: "force",
        showRelations: true, // Always fetch relations for graph
        nodeColor: "by-profile",
        edgeLabel: "relation-type",
        nodeSize: "auto",
      },
      list: {
        rowHeight: "default",
        showPreview: true,
      },
      grid: {
        cardSize: "default",
        showPreview: true,
      },
      gallery: {
        cardSize: "large",
        showPreview: true,
      },
      calendar: {
        dateField: "auto-detect", // First date property
        showRelations: false,
      },
      timeline: {
        timeField: "auto-detect", // First date/time property
        showRelations: false,
      },
    };

    return defaults[viewType] || {};
  }
}
