export type TemplateTargetType = "entity" | "document" | "project" | "inbox_item";
export type LayoutZone = "banner" | "header" | "sidebar" | "contentBefore" | "content" | "contentAfter" | "footer";
export type FieldRendererType = "text" | "badge" | "icon" | "avatar" | "avatarGroup" | "date" | "progress" | "checkbox" | "link" | "number" | "currency" | "relations" | "tags" | "code" | "image" | "timeline" | "backlinks" | "links" | "toc" | "embeddedView";
export interface ZoneConfig {
    enabled: boolean;
    slots?: string[];
    position?: "left" | "right";
    width?: string;
    layout?: "horizontal" | "vertical";
    align?: "left" | "center" | "right";
}
export interface HeaderConfig extends ZoneConfig {
    metadataPosition?: "inline" | "above" | "below";
    showIcon?: boolean;
}
export interface LayoutStructure {
    banner?: ZoneConfig;
    header?: HeaderConfig;
    sidebar?: ZoneConfig;
    contentBefore?: ZoneConfig;
    content?: ZoneConfig;
    contentAfter?: ZoneConfig;
    footer?: ZoneConfig;
}
export interface FieldRendererConfig {
    type: FieldRendererType;
    variant?: string;
    size?: string;
    format?: string;
    appearance?: "compact" | "detailed" | "cards";
    aspect?: "wide" | "square" | "tall";
}
export interface FieldSlotMapping {
    slot: string;
    renderer?: FieldRendererConfig;
    label?: string;
    showLabel?: boolean;
    order?: number;
}
export interface TemplateLayoutConfig {
    structure: LayoutStructure;
    fieldMapping: Record<string, FieldSlotMapping>;
}
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
    contentBefore?: {
        display?: string;
        gridTemplateColumns?: string;
        gap?: string;
    };
}
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
export interface TemplateConfig {
    layout?: TemplateLayoutConfig;
    colors?: TemplateColorsConfig;
    styling?: TemplateStylingConfig;
    containerStyling?: ContainerStyling;
    viewOverrides?: {
        modal?: Partial<TemplateLayoutConfig>;
        panel?: Partial<TemplateLayoutConfig>;
        full?: Partial<TemplateLayoutConfig>;
    };
}
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
//# sourceMappingURL=types.d.ts.map