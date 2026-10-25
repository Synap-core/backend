/**
 * The entity template row on the wire (`entity_templates` table) as the pod
 * reads and inserts it.
 *
 * The pod's type is inferred from its drizzle table; this package cannot see
 * that table, so the wire shape is declared here and `@synap/database` proves
 * it equal to the inferred one (`src/wire-parity/templates.ts`).
 */

export interface EntityTemplate {
  id: string;
  userId: string | null;
  workspaceId: string | null;
  name: string;
  description: string | null;
  targetType: string;
  entityType: string | null;
  inboxItemType: string | null;
  schema: unknown;
  config: unknown;
  isDefault: boolean;
  isPublic: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewEntityTemplate {
  id?: string;
  userId?: string | null;
  workspaceId?: string | null;
  name: string;
  description?: string | null;
  targetType: string;
  entityType?: string | null;
  inboxItemType?: string | null;
  schema?: unknown;
  config?: unknown;
  isDefault?: boolean;
  isPublic?: boolean;
  version?: number;
  createdAt?: Date;
  updatedAt?: Date;
}
