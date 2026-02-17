/**
 * View Type Enum Helper
 *
 * Utility to generate Zod enum from ViewType for runtime validation.
 * This ensures API validation stays in sync with the ViewType definition.
 */
import { z } from "zod";
import type { ViewType } from "./index.js";
/**
 * Array of all view types (for iteration, validation, etc.)
 */
export declare const VIEW_TYPES: ViewType[];
/**
 * Zod enum for view types (for API validation)
 * Generated from ViewType to ensure consistency
 */
export declare const ViewTypeEnum: z.ZodEnum<{
    table: "table";
    calendar: "calendar";
    whiteboard: "whiteboard";
    list: "list";
    grid: "grid";
    timeline: "timeline";
    graph: "graph";
    kanban: "kanban";
    gallery: "gallery";
    gantt: "gantt";
    mindmap: "mindmap";
    bento: "bento";
}>;
/**
 * Type guard: Check if a string is a valid ViewType
 */
export declare function isViewType(value: string): value is ViewType;
//# sourceMappingURL=view-type-enum.d.ts.map