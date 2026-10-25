/**
 * User preferences on the wire — the `user_preferences` row and the shapes of
 * its JSONB columns.
 *
 * The JSONB shapes are declared HERE, once: `@synap/database` imports them to
 * type its columns and re-exports them. The row itself is inferred from the
 * drizzle table on the pod side; it is declared here and the database proves
 * it equal (`packages/database/src/wire-parity/preferences.ts`). Pure types:
 * nothing from the database package.
 */

export interface CustomTheme {
  colors?: {
    primary?: string;
    accent?: string;
    background?: string;
    border?: string;
    text?: string;
  };
  spacing?: {
    small?: string;
    medium?: string;
    large?: string;
  };
  radii?: {
    small?: string;
    medium?: string;
    large?: string;
  };
  animations?: {
    enabled?: boolean;
    speed?: "slow" | "normal" | "fast";
  };
}

export interface DefaultTemplates {
  [entityType: string]: string; // entityType -> templateId
}

export interface CustomEntityType {
  id: string;
  name: string;
  icon: string;
  color: string;
  metadataSchema: Record<string, any>;
}

export interface EntityMetadataSchemas {
  [entityType: string]: Record<string, any>;
}

/** How to open entity detail when user clicks an entity (workspace-wide) */
export type EntityOpenMode = "floating" | "side" | "modal";

export interface UIPreferences {
  sidebarCollapsed?: boolean;
  panelPositions?: Record<string, { x: number; y: number }>;
  lastActiveView?: string;
  compactMode?: boolean;
  fontSize?: string;
  animations?: boolean;
  defaultView?: "list" | "grid" | "timeline";
  /** Where to open entity detail: floating panel (default), side panel, or modal */
  entityOpenMode?: EntityOpenMode;
}

export interface GraphPreferences {
  forceSettings?: {
    linkDistance?: number;
    chargeStrength?: number;
    alphaDecay?: number;
    velocityDecay?: number;
  };
  defaultFilters?: {
    entityTypes?: string[];
    relationTypes?: string[];
  };
  zoom?: number;
  pan?: { x: number; y: number };
  showMinimap?: boolean;
}

/** `user_preferences.intelligence_service_preferences`. */
export interface IntelligenceServicePreferences {
  default?: string;
  chat?: string;
  analysis?: string;
  defaultCompanionAgentId?: string;
}

/** A `user_preferences` row, as the pod reads it. */
export interface UserPreference {
  userId: string;
  theme: string;
  customTheme: CustomTheme | null;
  defaultTemplates: DefaultTemplates | null;
  customEntityTypes: CustomEntityType[] | null;
  entityMetadataSchemas: EntityMetadataSchemas | null;
  uiPreferences: UIPreferences;
  graphPreferences: GraphPreferences;
  intelligenceServicePreferences: IntelligenceServicePreferences;
  onboardingCompleted: boolean;
  onboardingStep: string | null;
  homeLastSeenAt: Date | null;
  updatedAt: Date;
}

/** A `user_preferences` row, as the pod inserts it. */
export interface NewUserPreference {
  userId: string;
  theme?: string;
  customTheme?: CustomTheme | null;
  defaultTemplates?: DefaultTemplates | null;
  customEntityTypes?: CustomEntityType[] | null;
  entityMetadataSchemas?: EntityMetadataSchemas | null;
  uiPreferences?: UIPreferences;
  graphPreferences?: GraphPreferences;
  intelligenceServicePreferences?: IntelligenceServicePreferences;
  onboardingCompleted?: boolean;
  onboardingStep?: string | null;
  homeLastSeenAt?: Date | null;
  updatedAt?: Date;
}
