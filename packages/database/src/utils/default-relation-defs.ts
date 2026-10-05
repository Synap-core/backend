/**
 * Default Relation Definitions
 *
 * The domain-level relation types seeded into every new workspace.
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
 * Domain-level relation types seeded into every workspace.
 *
 * Every DIRECTIONAL default carries `uiHints.inverseLabel` — the words read from
 * the TARGET's side ("<focus> <inverseLabel> <source>"). Without one the far end
 * showed the forward word plus a reversed-arrow mark (`resolveConnectionLabel`).
 * `blocks` / `depends_on` now land on the dependency link (`blocked_by`), but
 * their old rows still exist and still render, so they keep labels too.
 * Existing pods converge through `ensureDefaultRelationDefs`, which fills an
 * ABSENT inverse label and never overwrites one a workspace set.
 *
 * `as const` so the slugs are a literal union: the node-neighbourhood role
 * table (`@synap-core/types/connections` RELATION_EDGE_ROLES) is pinned to it
 * by a compile-time floor (api `services/object-graph/edge-role-coverage.ts`)
 * — a new default relation fails the build until it is given a zone.
 */
export const DEFAULT_RELATION_DEFS = [
  {
    slug: "assigned_to",
    displayName: "Assigned To",
    description: "Person assigned to task/project",
    isDirectional: true,
    uiHints: { category: "workflow", inverseLabel: "Assignee of" },
  },
  {
    slug: "blocks",
    displayName: "Blocks",
    description: "Prevents progress on another task",
    isDirectional: true,
    uiHints: { category: "workflow", inverseLabel: "Blocked by" },
  },
  {
    slug: "depends_on",
    displayName: "Depends On",
    description: "Requires completion of another task",
    isDirectional: true,
    uiHints: { category: "workflow", inverseLabel: "Required by" },
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
    uiHints: { category: "reference", inverseLabel: "Mentioned in" },
  },
  {
    slug: "links_to",
    displayName: "Links To",
    description: "Hyperlink or reference",
    isDirectional: true,
    uiHints: { category: "reference", inverseLabel: "Linked from" },
  },
  {
    slug: "parent_of",
    displayName: "Parent Of",
    description: "Hierarchical parent relationship",
    isDirectional: true,
    uiHints: { category: "hierarchy", inverseLabel: "Child of" },
  },
  {
    slug: "tagged_with",
    displayName: "Tagged With",
    description: "Categorization tag",
    isDirectional: true,
    uiHints: { category: "reference", inverseLabel: "Tags" },
  },
  {
    slug: "created_by",
    displayName: "Created By",
    description: "Author or creator",
    isDirectional: true,
    uiHints: { category: "social", inverseLabel: "Created" },
  },
  {
    slug: "attended_by",
    displayName: "Attended By",
    description: "Participant in event",
    isDirectional: true,
    uiHints: { category: "social", inverseLabel: "Attended" },
  },
  {
    slug: "belongs_to_project",
    displayName: "Belongs To Project",
    description: "Project membership",
    isDirectional: true,
    uiHints: { category: "hierarchy", inverseLabel: "Includes" },
  },
  {
    slug: "founder_brand_of",
    displayName: "Founder Brand Of",
    description:
      "A personal-brand project is the founder brand of a company project — links a person's brand to the company it expresses",
    isDirectional: true,
    uiHints: { category: "hierarchy", inverseLabel: "Expression of" },
  },
  {
    slug: "references",
    displayName: "References",
    description: "Cites or refers to",
    isDirectional: true,
    uiHints: { category: "reference", inverseLabel: "Referenced by" },
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
  {
    slug: "advances",
    displayName: "Advances",
    description: "advances the company's Foundation mission/vision goal",
    isDirectional: true,
    uiHints: { category: "workflow", inverseLabel: "Advanced by" },
  },
  // Relay: relationship graph relation types
  {
    slug: "met_at",
    displayName: "Met at",
    description: "Person met at an event or gathering",
    isDirectional: true,
    uiHints: { category: "social", inverseLabel: "Attendees" },
  },
  {
    slug: "works_on",
    displayName: "Works on",
    description: "Person contributes to a project",
    isDirectional: true,
    uiHints: { category: "workflow", inverseLabel: "Contributors" },
  },
  {
    slug: "has_skill",
    displayName: "Has skill",
    description: "Person possesses a skill or expertise",
    isDirectional: true,
    uiHints: { category: "reference", inverseLabel: "Skilled people" },
  },
  {
    slug: "affiliated_with",
    displayName: "Affiliated with",
    description: "Person affiliated with an organization",
    isDirectional: true,
    uiHints: { category: "social", inverseLabel: "Members" },
  },
  {
    slug: "knows",
    displayName: "Knows",
    description: "Two people know each other",
    isDirectional: false,
    uiHints: { category: "social" },
  },
  {
    slug: "discussed_with",
    displayName: "Discussed with",
    description: "Had a discussion or conversation with",
    isDirectional: false,
    uiHints: { category: "social" },
  },
] as const satisfies readonly DefaultRelationDef[];

/**
 * System-internal relation types — not user-facing, not shown in listTypes.
 * Used for tracking embedding/visualization relationships.
 */
export const SYSTEM_RELATION_TYPES = ["embedded_in", "visualized_in"] as const;
