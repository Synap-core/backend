/**
 * Default Relation Definitions
 *
 * The 12 domain-level relation types seeded into every new workspace.
 * These were previously hardcoded in RelationTypeSchema and RELATION_TYPE_METADATA.
 * Now they live as relation_defs rows in the database, making them customizable per workspace.
 *
 * Two system-internal types (embedded_in, visualized_in) are kept as code constants
 * since they're not user-facing.
 */

export interface DefaultRelationDef {
  slug: string;
  displayName: string;
  description: string;
  isDirectional: boolean;
  uiHints: {
    category: "workflow" | "social" | "reference" | "hierarchy";
    inverseLabel?: string;
  };
}

/**
 * 12 domain-level relation types seeded into every workspace.
 */
export const DEFAULT_RELATION_DEFS: DefaultRelationDef[] = [
  {
    slug: "assigned_to",
    displayName: "Assigned To",
    description: "Person assigned to task/project",
    isDirectional: true,
    uiHints: { category: "workflow" },
  },
  {
    slug: "blocks",
    displayName: "Blocks",
    description: "Prevents progress on another task",
    isDirectional: true,
    uiHints: { category: "workflow" },
  },
  {
    slug: "depends_on",
    displayName: "Depends On",
    description: "Requires completion of another task",
    isDirectional: true,
    uiHints: { category: "workflow" },
  },
  {
    slug: "relates_to",
    displayName: "Relates To",
    description: "General relationship between entities",
    isDirectional: false,
    uiHints: { category: "reference" },
  },
  {
    slug: "mentions",
    displayName: "Mentions",
    description: "Referenced in content",
    isDirectional: true,
    uiHints: { category: "reference" },
  },
  {
    slug: "links_to",
    displayName: "Links To",
    description: "Hyperlink or reference",
    isDirectional: true,
    uiHints: { category: "reference" },
  },
  {
    slug: "parent_of",
    displayName: "Parent Of",
    description: "Hierarchical parent relationship",
    isDirectional: true,
    uiHints: { category: "hierarchy" },
  },
  {
    slug: "tagged_with",
    displayName: "Tagged With",
    description: "Categorization tag",
    isDirectional: true,
    uiHints: { category: "reference" },
  },
  {
    slug: "created_by",
    displayName: "Created By",
    description: "Author or creator",
    isDirectional: true,
    uiHints: { category: "social" },
  },
  {
    slug: "attended_by",
    displayName: "Attended By",
    description: "Participant in event",
    isDirectional: true,
    uiHints: { category: "social" },
  },
  {
    slug: "belongs_to_project",
    displayName: "Belongs To Project",
    description: "Project membership",
    isDirectional: true,
    uiHints: { category: "hierarchy" },
  },
  {
    slug: "references",
    displayName: "References",
    description: "Cites or refers to",
    isDirectional: true,
    uiHints: { category: "reference" },
  },
  {
    slug: "works_at",
    displayName: "Works At",
    description: "Person works at an organization",
    isDirectional: true,
    uiHints: { category: "social", inverseLabel: "Employs" },
  },
  {
    slug: "deal_for",
    displayName: "Deal For",
    description: "Sales deal associated with a contact",
    isDirectional: true,
    uiHints: { category: "workflow", inverseLabel: "Has Deal" },
  },
];

/**
 * System-internal relation types — not user-facing, not shown in listTypes.
 * Used for tracking embedding/visualization relationships.
 */
export const SYSTEM_RELATION_TYPES = ["embedded_in", "visualized_in"] as const;
