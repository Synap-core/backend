/**
 * View Config Types
 *
 * TypeScript types inferred from Zod schemas.
 * Provides type safety for view configs in frontend and backend.
 */

import type { z } from "zod";
import {
  TableViewConfigSchema,
  KanbanViewConfigSchema,
  ListViewConfigSchema,
  GridViewConfigSchema,
  GalleryViewConfigSchema,
  CalendarViewConfigSchema,
  GanttViewConfigSchema,
  TimelineViewConfigSchema,
  GraphViewConfigSchema,
  BentoViewConfigSchema,
  WhiteboardViewConfigSchema,
  MindmapViewConfigSchema,
} from "./config-schemas.js";

// =============================================================================
// Type-Safe Config Types (Inferred from Zod Schemas)
// =============================================================================

/**
 * Table view config type
 */
export type TableViewConfig = z.infer<typeof TableViewConfigSchema>;

/**
 * Kanban view config type
 */
export type KanbanViewConfig = z.infer<typeof KanbanViewConfigSchema>;

/**
 * List view config type
 */
export type ListViewConfig = z.infer<typeof ListViewConfigSchema>;

/**
 * Grid view config type
 */
export type GridViewConfig = z.infer<typeof GridViewConfigSchema>;

/**
 * Gallery view config type
 */
export type GalleryViewConfig = z.infer<typeof GalleryViewConfigSchema>;

/**
 * Calendar view config type
 */
export type CalendarViewConfig = z.infer<typeof CalendarViewConfigSchema>;

/**
 * Gantt view config type
 */
export type GanttViewConfig = z.infer<typeof GanttViewConfigSchema>;

/**
 * Timeline view config type
 */
export type TimelineViewConfig = z.infer<typeof TimelineViewConfigSchema>;

/**
 * Graph view config type
 */
export type GraphViewConfig = z.infer<typeof GraphViewConfigSchema>;

/**
 * Bento grid view config type
 */
export type BentoViewConfig = z.infer<typeof BentoViewConfigSchema>;

/**
 * Whiteboard view config type
 */
export type WhiteboardViewConfig = z.infer<typeof WhiteboardViewConfigSchema>;

/**
 * Mindmap view config type
 */
export type MindmapViewConfig = z.infer<typeof MindmapViewConfigSchema>;

// =============================================================================
// Discriminated Union (Type-Safe Config Access)
// =============================================================================

/**
 * Discriminated union of all view config types
 * Use the view type to narrow the config type
 */
export type ViewConfigByType =
  | { type: "table"; config: TableViewConfig }
  | { type: "kanban"; config: KanbanViewConfig }
  | { type: "list"; config: ListViewConfig }
  | { type: "grid"; config: GridViewConfig }
  | { type: "gallery"; config: GalleryViewConfig }
  | { type: "calendar"; config: CalendarViewConfig }
  | { type: "gantt"; config: GanttViewConfig }
  | { type: "timeline"; config: TimelineViewConfig }
  | { type: "graph"; config: GraphViewConfig }
  | { type: "bento"; config: BentoViewConfig }
  | { type: "whiteboard"; config: WhiteboardViewConfig }
  | { type: "mindmap"; config: MindmapViewConfig };
