// Target Types
export type TemplateTargetType =
  | "entity"
  | "document"
  | "project"
  | "inbox_item";
export type LayoutZone =
  | "banner"
  | "header"
  | "sidebar"
  | "contentBefore"
  | "content"
  | "contentAfter"
  | "footer";
export type FieldRendererType =
  | "text"
  | "badge"
  | "icon"
  | "avatar"
  | "avatarGroup"
  | "date"
  | "progress"
  | "checkbox"
  | "link"
  | "number"
  | "currency"
  | "relations"
  | "tags"
  | "code"
  | "image"
  | "timeline"
  | "backlinks"
  | "links"
  | "toc"
  | "embeddedView";

// Zone Configuration
export interface ZoneConfig {
  enabled: boolean;
  slots?: string[];
  position?: "left" | "right"; // For sidebar
  width?: string; // For sidebar
  layout?: "horizontal" | "vertical"; // For header/zones with multiple items
  align?: "left" | "center" | "right";
}

// Header-specific configuration
export interface HeaderConfig extends ZoneConfig {
  metadataPosition?: "inline" | "above" | "below"; // Where metadata appears relative to title
  showIcon?: boolean;
}

// Layout Configuration
export interface LayoutStructure {
  banner?: ZoneConfig;
  header?: HeaderConfig; // Enhanced with header-specific options
  sidebar?: ZoneConfig;
  contentBefore?: ZoneConfig;
  content?: ZoneConfig;
  contentAfter?: ZoneConfig;
  footer?: ZoneConfig;
}

// Field Mapping
export interface FieldRendererConfig {
  type: FieldRendererType;
  variant?: string;
  size?: string;
  format?: string;
  appearance?: "compact" | "detailed" | "cards"; // For relations
  aspect?: "wide" | "square" | "tall"; // For images
}

export interface FieldSlotMapping {
  slot: string; // e.g., "header.metadata" or "contentBefore.propertiesGrid"
  renderer?: FieldRendererConfig;
  label?: string;
  showLabel?: boolean;
  order?: number;
}

export interface TemplateLayoutConfig {
  structure: LayoutStructure;
  fieldMapping: Record<string, FieldSlotMapping>;
}

// Colors & Styling
export interface TemplateColorsConfig {
  primary?: string;
  accent?: string;
  background?: string;
  border?: string;
  text?: string;
  muted?: string;
  success?: string;
  warning?: string;
  error?: string;
}

export interface TemplateStylingConfig {
  borderRadius?: string;
  padding?: string;
  gap?: string;
  fontSize?: string;
  fontWeight?: string;
  shadow?: string;
  fontFamily?: string;
  // Zone-specific styling
  contentBefore?: {
    display?: string;
    gridTemplateColumns?: string;
    gap?: string;
  };
}

// Container-specific styling for different view types
export interface ContainerStyling {
  modal?: {
    maxWidth?: string;
    maxHeight?: string;
    borderRadius?: string;
  };
  panel?: {
    width?: string;
    minWidth?: string;
    maxWidth?: string;
  };
  full?: {
    maxWidth?: string;
    padding?: string;
  };
}

// Complete Configuration
export interface TemplateConfig {
  layout?: TemplateLayoutConfig;
  colors?: TemplateColorsConfig;
  styling?: TemplateStylingConfig;
  containerStyling?: ContainerStyling;

  // View-specific overrides
  viewOverrides?: {
    modal?: Partial<TemplateLayoutConfig>;
    panel?: Partial<TemplateLayoutConfig>;
    full?: Partial<TemplateLayoutConfig>;
  };
}

// Entity Template
export interface EntityTemplate {
  id: string;
  userId?: string | null;
  workspaceId?: string | null;
  name: string;
  description?: string | null;
  targetType: TemplateTargetType;
  entityType?: string | null;
  inboxItemType?: string | null;
  config: TemplateConfig;
  isDefault: boolean;
  isPublic: boolean;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

// =============================================================================
// API Input Types
// =============================================================================

/**
 * Input for listing templates
 */
export interface ListTemplatesInput {
  targetType?: TemplateTargetType;
  entityType?: string;
  inboxItemType?: string;
  workspaceId?: string;
  includePublic?: boolean;
}

/**
 * Input for getting default template with smart fallback resolution
 */
export interface GetDefaultTemplateInput {
  targetType: TemplateTargetType;
  entityType?: string;
  inboxItemType?: string;
  workspaceId?: string;
}

/**
 * Input for creating a new template
 */
export interface CreateTemplateInput {
  name: string;
  description?: string;
  targetType: TemplateTargetType;
  entityType?: string;
  inboxItemType?: string;
  config: TemplateConfig;
  isDefault?: boolean;
  isPublic?: boolean;
  workspaceId?: string;
}

/**
 * Input for updating an existing template
 */
export interface UpdateTemplateInput {
  id: string;
  name?: string;
  description?: string;
  config?: TemplateConfig;
  isDefault?: boolean;
  isPublic?: boolean;
}

/**
 * Input for duplicating a template
 */
export interface DuplicateTemplateInput {
  id: string;
}

/**
 * Input for setting a template as default
 */
export interface SetDefaultTemplateInput {
  id: string;
}

/**
 * Input for deleting a template
 */
export interface DeleteTemplateInput {
  id: string;
}
