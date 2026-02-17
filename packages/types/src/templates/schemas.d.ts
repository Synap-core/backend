import { z } from "zod";
export declare const TemplateTargetTypeSchema: z.ZodEnum<{
    entity: "entity";
    document: "document";
    project: "project";
    inbox_item: "inbox_item";
}>;
export declare const SectionTypeSchema: z.ZodEnum<{
    content: "content";
    metadata: "metadata";
    relations: "relations";
    banner: "banner";
    header: "header";
    sidebar: "sidebar";
    contentBefore: "contentBefore";
    contentAfter: "contentAfter";
    footer: "footer";
}>;
export declare const LayoutZoneSchema: z.ZodEnum<{
    content: "content";
    banner: "banner";
    header: "header";
    sidebar: "sidebar";
    contentBefore: "contentBefore";
    contentAfter: "contentAfter";
    footer: "footer";
}>;
export declare const ZoneConfigSchema: z.ZodObject<{
    enabled: z.ZodBoolean;
    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    position: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
    }>>;
    width: z.ZodOptional<z.ZodString>;
    layout: z.ZodOptional<z.ZodEnum<{
        horizontal: "horizontal";
        vertical: "vertical";
    }>>;
    align: z.ZodOptional<z.ZodEnum<{
        left: "left";
        right: "right";
        center: "center";
    }>>;
}, z.core.$strip>;
export declare const LayoutStructureSchema: z.ZodObject<{
    banner: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
        slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        position: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
        }>>;
        width: z.ZodOptional<z.ZodString>;
        layout: z.ZodOptional<z.ZodEnum<{
            horizontal: "horizontal";
            vertical: "vertical";
        }>>;
        align: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
            center: "center";
        }>>;
    }, z.core.$strip>>;
    header: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
        slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        position: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
        }>>;
        width: z.ZodOptional<z.ZodString>;
        layout: z.ZodOptional<z.ZodEnum<{
            horizontal: "horizontal";
            vertical: "vertical";
        }>>;
        align: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
            center: "center";
        }>>;
    }, z.core.$strip>>;
    sidebar: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
        slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        position: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
        }>>;
        width: z.ZodOptional<z.ZodString>;
        layout: z.ZodOptional<z.ZodEnum<{
            horizontal: "horizontal";
            vertical: "vertical";
        }>>;
        align: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
            center: "center";
        }>>;
    }, z.core.$strip>>;
    contentBefore: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
        slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        position: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
        }>>;
        width: z.ZodOptional<z.ZodString>;
        layout: z.ZodOptional<z.ZodEnum<{
            horizontal: "horizontal";
            vertical: "vertical";
        }>>;
        align: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
            center: "center";
        }>>;
    }, z.core.$strip>>;
    content: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
        slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        position: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
        }>>;
        width: z.ZodOptional<z.ZodString>;
        layout: z.ZodOptional<z.ZodEnum<{
            horizontal: "horizontal";
            vertical: "vertical";
        }>>;
        align: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
            center: "center";
        }>>;
    }, z.core.$strip>>;
    contentAfter: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
        slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        position: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
        }>>;
        width: z.ZodOptional<z.ZodString>;
        layout: z.ZodOptional<z.ZodEnum<{
            horizontal: "horizontal";
            vertical: "vertical";
        }>>;
        align: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
            center: "center";
        }>>;
    }, z.core.$strip>>;
    footer: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
        slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        position: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
        }>>;
        width: z.ZodOptional<z.ZodString>;
        layout: z.ZodOptional<z.ZodEnum<{
            horizontal: "horizontal";
            vertical: "vertical";
        }>>;
        align: z.ZodOptional<z.ZodEnum<{
            left: "left";
            right: "right";
            center: "center";
        }>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const FieldRendererTypeSchema: z.ZodEnum<{
    number: "number";
    text: "text";
    date: "date";
    link: "link";
    relations: "relations";
    badge: "badge";
    avatar: "avatar";
    progress: "progress";
    checkbox: "checkbox";
    currency: "currency";
}>;
export declare const FieldRendererConfigSchema: z.ZodObject<{
    type: z.ZodEnum<{
        number: "number";
        text: "text";
        date: "date";
        link: "link";
        relations: "relations";
        badge: "badge";
        avatar: "avatar";
        progress: "progress";
        checkbox: "checkbox";
        currency: "currency";
    }>;
    variant: z.ZodOptional<z.ZodString>;
    size: z.ZodOptional<z.ZodString>;
    format: z.ZodOptional<z.ZodString>;
    appearance: z.ZodOptional<z.ZodEnum<{
        compact: "compact";
        detailed: "detailed";
        cards: "cards";
    }>>;
}, z.core.$strip>;
export declare const FieldSlotMappingSchema: z.ZodObject<{
    slot: z.ZodString;
    renderer: z.ZodOptional<z.ZodObject<{
        type: z.ZodEnum<{
            number: "number";
            text: "text";
            date: "date";
            link: "link";
            relations: "relations";
            badge: "badge";
            avatar: "avatar";
            progress: "progress";
            checkbox: "checkbox";
            currency: "currency";
        }>;
        variant: z.ZodOptional<z.ZodString>;
        size: z.ZodOptional<z.ZodString>;
        format: z.ZodOptional<z.ZodString>;
        appearance: z.ZodOptional<z.ZodEnum<{
            compact: "compact";
            detailed: "detailed";
            cards: "cards";
        }>>;
    }, z.core.$strip>>;
    label: z.ZodOptional<z.ZodString>;
    showLabel: z.ZodOptional<z.ZodBoolean>;
    order: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const TemplateLayoutConfigSchema: z.ZodObject<{
    structure: z.ZodObject<{
        banner: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
            slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
            position: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
            }>>;
            width: z.ZodOptional<z.ZodString>;
            layout: z.ZodOptional<z.ZodEnum<{
                horizontal: "horizontal";
                vertical: "vertical";
            }>>;
            align: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
                center: "center";
            }>>;
        }, z.core.$strip>>;
        header: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
            slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
            position: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
            }>>;
            width: z.ZodOptional<z.ZodString>;
            layout: z.ZodOptional<z.ZodEnum<{
                horizontal: "horizontal";
                vertical: "vertical";
            }>>;
            align: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
                center: "center";
            }>>;
        }, z.core.$strip>>;
        sidebar: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
            slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
            position: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
            }>>;
            width: z.ZodOptional<z.ZodString>;
            layout: z.ZodOptional<z.ZodEnum<{
                horizontal: "horizontal";
                vertical: "vertical";
            }>>;
            align: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
                center: "center";
            }>>;
        }, z.core.$strip>>;
        contentBefore: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
            slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
            position: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
            }>>;
            width: z.ZodOptional<z.ZodString>;
            layout: z.ZodOptional<z.ZodEnum<{
                horizontal: "horizontal";
                vertical: "vertical";
            }>>;
            align: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
                center: "center";
            }>>;
        }, z.core.$strip>>;
        content: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
            slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
            position: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
            }>>;
            width: z.ZodOptional<z.ZodString>;
            layout: z.ZodOptional<z.ZodEnum<{
                horizontal: "horizontal";
                vertical: "vertical";
            }>>;
            align: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
                center: "center";
            }>>;
        }, z.core.$strip>>;
        contentAfter: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
            slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
            position: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
            }>>;
            width: z.ZodOptional<z.ZodString>;
            layout: z.ZodOptional<z.ZodEnum<{
                horizontal: "horizontal";
                vertical: "vertical";
            }>>;
            align: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
                center: "center";
            }>>;
        }, z.core.$strip>>;
        footer: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
            slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
            position: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
            }>>;
            width: z.ZodOptional<z.ZodString>;
            layout: z.ZodOptional<z.ZodEnum<{
                horizontal: "horizontal";
                vertical: "vertical";
            }>>;
            align: z.ZodOptional<z.ZodEnum<{
                left: "left";
                right: "right";
                center: "center";
            }>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    fieldMapping: z.ZodRecord<z.ZodString, z.ZodObject<{
        slot: z.ZodString;
        renderer: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<{
                number: "number";
                text: "text";
                date: "date";
                link: "link";
                relations: "relations";
                badge: "badge";
                avatar: "avatar";
                progress: "progress";
                checkbox: "checkbox";
                currency: "currency";
            }>;
            variant: z.ZodOptional<z.ZodString>;
            size: z.ZodOptional<z.ZodString>;
            format: z.ZodOptional<z.ZodString>;
            appearance: z.ZodOptional<z.ZodEnum<{
                compact: "compact";
                detailed: "detailed";
                cards: "cards";
            }>>;
        }, z.core.$strip>>;
        label: z.ZodOptional<z.ZodString>;
        showLabel: z.ZodOptional<z.ZodBoolean>;
        order: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const TemplateColorsConfigSchema: z.ZodObject<{
    primary: z.ZodOptional<z.ZodString>;
    accent: z.ZodOptional<z.ZodString>;
    background: z.ZodOptional<z.ZodString>;
    border: z.ZodOptional<z.ZodString>;
    text: z.ZodOptional<z.ZodString>;
    muted: z.ZodOptional<z.ZodString>;
    success: z.ZodOptional<z.ZodString>;
    warning: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const TemplateStylingConfigSchema: z.ZodObject<{
    borderRadius: z.ZodOptional<z.ZodString>;
    padding: z.ZodOptional<z.ZodString>;
    gap: z.ZodOptional<z.ZodString>;
    fontSize: z.ZodOptional<z.ZodString>;
    fontWeight: z.ZodOptional<z.ZodString>;
    shadow: z.ZodOptional<z.ZodString>;
    fontFamily: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const TemplateConfigSchema: z.ZodObject<{
    layout: z.ZodOptional<z.ZodObject<{
        structure: z.ZodObject<{
            banner: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodBoolean;
                slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                position: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                }>>;
                width: z.ZodOptional<z.ZodString>;
                layout: z.ZodOptional<z.ZodEnum<{
                    horizontal: "horizontal";
                    vertical: "vertical";
                }>>;
                align: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                    center: "center";
                }>>;
            }, z.core.$strip>>;
            header: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodBoolean;
                slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                position: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                }>>;
                width: z.ZodOptional<z.ZodString>;
                layout: z.ZodOptional<z.ZodEnum<{
                    horizontal: "horizontal";
                    vertical: "vertical";
                }>>;
                align: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                    center: "center";
                }>>;
            }, z.core.$strip>>;
            sidebar: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodBoolean;
                slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                position: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                }>>;
                width: z.ZodOptional<z.ZodString>;
                layout: z.ZodOptional<z.ZodEnum<{
                    horizontal: "horizontal";
                    vertical: "vertical";
                }>>;
                align: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                    center: "center";
                }>>;
            }, z.core.$strip>>;
            contentBefore: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodBoolean;
                slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                position: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                }>>;
                width: z.ZodOptional<z.ZodString>;
                layout: z.ZodOptional<z.ZodEnum<{
                    horizontal: "horizontal";
                    vertical: "vertical";
                }>>;
                align: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                    center: "center";
                }>>;
            }, z.core.$strip>>;
            content: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodBoolean;
                slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                position: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                }>>;
                width: z.ZodOptional<z.ZodString>;
                layout: z.ZodOptional<z.ZodEnum<{
                    horizontal: "horizontal";
                    vertical: "vertical";
                }>>;
                align: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                    center: "center";
                }>>;
            }, z.core.$strip>>;
            contentAfter: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodBoolean;
                slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                position: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                }>>;
                width: z.ZodOptional<z.ZodString>;
                layout: z.ZodOptional<z.ZodEnum<{
                    horizontal: "horizontal";
                    vertical: "vertical";
                }>>;
                align: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                    center: "center";
                }>>;
            }, z.core.$strip>>;
            footer: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodBoolean;
                slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                position: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                }>>;
                width: z.ZodOptional<z.ZodString>;
                layout: z.ZodOptional<z.ZodEnum<{
                    horizontal: "horizontal";
                    vertical: "vertical";
                }>>;
                align: z.ZodOptional<z.ZodEnum<{
                    left: "left";
                    right: "right";
                    center: "center";
                }>>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        fieldMapping: z.ZodRecord<z.ZodString, z.ZodObject<{
            slot: z.ZodString;
            renderer: z.ZodOptional<z.ZodObject<{
                type: z.ZodEnum<{
                    number: "number";
                    text: "text";
                    date: "date";
                    link: "link";
                    relations: "relations";
                    badge: "badge";
                    avatar: "avatar";
                    progress: "progress";
                    checkbox: "checkbox";
                    currency: "currency";
                }>;
                variant: z.ZodOptional<z.ZodString>;
                size: z.ZodOptional<z.ZodString>;
                format: z.ZodOptional<z.ZodString>;
                appearance: z.ZodOptional<z.ZodEnum<{
                    compact: "compact";
                    detailed: "detailed";
                    cards: "cards";
                }>>;
            }, z.core.$strip>>;
            label: z.ZodOptional<z.ZodString>;
            showLabel: z.ZodOptional<z.ZodBoolean>;
            order: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    colors: z.ZodOptional<z.ZodObject<{
        primary: z.ZodOptional<z.ZodString>;
        accent: z.ZodOptional<z.ZodString>;
        background: z.ZodOptional<z.ZodString>;
        border: z.ZodOptional<z.ZodString>;
        text: z.ZodOptional<z.ZodString>;
        muted: z.ZodOptional<z.ZodString>;
        success: z.ZodOptional<z.ZodString>;
        warning: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    styling: z.ZodOptional<z.ZodObject<{
        borderRadius: z.ZodOptional<z.ZodString>;
        padding: z.ZodOptional<z.ZodString>;
        gap: z.ZodOptional<z.ZodString>;
        fontSize: z.ZodOptional<z.ZodString>;
        fontWeight: z.ZodOptional<z.ZodString>;
        shadow: z.ZodOptional<z.ZodString>;
        fontFamily: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const EntityTemplateSchema: z.ZodObject<{
    id: z.ZodString;
    userId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    workspaceId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    targetType: z.ZodEnum<{
        entity: "entity";
        document: "document";
        project: "project";
        inbox_item: "inbox_item";
    }>;
    entityType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    inboxItemType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    config: z.ZodObject<{
        layout: z.ZodOptional<z.ZodObject<{
            structure: z.ZodObject<{
                banner: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                header: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                sidebar: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                contentBefore: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                content: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                contentAfter: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                footer: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
            }, z.core.$strip>;
            fieldMapping: z.ZodRecord<z.ZodString, z.ZodObject<{
                slot: z.ZodString;
                renderer: z.ZodOptional<z.ZodObject<{
                    type: z.ZodEnum<{
                        number: "number";
                        text: "text";
                        date: "date";
                        link: "link";
                        relations: "relations";
                        badge: "badge";
                        avatar: "avatar";
                        progress: "progress";
                        checkbox: "checkbox";
                        currency: "currency";
                    }>;
                    variant: z.ZodOptional<z.ZodString>;
                    size: z.ZodOptional<z.ZodString>;
                    format: z.ZodOptional<z.ZodString>;
                    appearance: z.ZodOptional<z.ZodEnum<{
                        compact: "compact";
                        detailed: "detailed";
                        cards: "cards";
                    }>>;
                }, z.core.$strip>>;
                label: z.ZodOptional<z.ZodString>;
                showLabel: z.ZodOptional<z.ZodBoolean>;
                order: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        colors: z.ZodOptional<z.ZodObject<{
            primary: z.ZodOptional<z.ZodString>;
            accent: z.ZodOptional<z.ZodString>;
            background: z.ZodOptional<z.ZodString>;
            border: z.ZodOptional<z.ZodString>;
            text: z.ZodOptional<z.ZodString>;
            muted: z.ZodOptional<z.ZodString>;
            success: z.ZodOptional<z.ZodString>;
            warning: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        styling: z.ZodOptional<z.ZodObject<{
            borderRadius: z.ZodOptional<z.ZodString>;
            padding: z.ZodOptional<z.ZodString>;
            gap: z.ZodOptional<z.ZodString>;
            fontSize: z.ZodOptional<z.ZodString>;
            fontWeight: z.ZodOptional<z.ZodString>;
            shadow: z.ZodOptional<z.ZodString>;
            fontFamily: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    isDefault: z.ZodDefault<z.ZodBoolean>;
    isPublic: z.ZodDefault<z.ZodBoolean>;
    version: z.ZodDefault<z.ZodNumber>;
    createdAt: z.ZodUnion<[z.ZodDate, z.ZodString]>;
    updatedAt: z.ZodUnion<[z.ZodDate, z.ZodString]>;
}, z.core.$strip>;
export declare const ListTemplatesInputSchema: z.ZodObject<{
    targetType: z.ZodOptional<z.ZodEnum<{
        entity: "entity";
        document: "document";
        project: "project";
        inbox_item: "inbox_item";
    }>>;
    entityType: z.ZodOptional<z.ZodString>;
    inboxItemType: z.ZodOptional<z.ZodString>;
    workspaceId: z.ZodOptional<z.ZodString>;
    includePublic: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export declare const GetDefaultTemplateInputSchema: z.ZodObject<{
    targetType: z.ZodEnum<{
        entity: "entity";
        document: "document";
        project: "project";
        inbox_item: "inbox_item";
    }>;
    entityType: z.ZodOptional<z.ZodString>;
    inboxItemType: z.ZodOptional<z.ZodString>;
    workspaceId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const CreateTemplateInputSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    targetType: z.ZodEnum<{
        entity: "entity";
        document: "document";
        project: "project";
        inbox_item: "inbox_item";
    }>;
    entityType: z.ZodOptional<z.ZodString>;
    inboxItemType: z.ZodOptional<z.ZodString>;
    config: z.ZodObject<{
        layout: z.ZodOptional<z.ZodObject<{
            structure: z.ZodObject<{
                banner: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                header: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                sidebar: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                contentBefore: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                content: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                contentAfter: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                footer: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
            }, z.core.$strip>;
            fieldMapping: z.ZodRecord<z.ZodString, z.ZodObject<{
                slot: z.ZodString;
                renderer: z.ZodOptional<z.ZodObject<{
                    type: z.ZodEnum<{
                        number: "number";
                        text: "text";
                        date: "date";
                        link: "link";
                        relations: "relations";
                        badge: "badge";
                        avatar: "avatar";
                        progress: "progress";
                        checkbox: "checkbox";
                        currency: "currency";
                    }>;
                    variant: z.ZodOptional<z.ZodString>;
                    size: z.ZodOptional<z.ZodString>;
                    format: z.ZodOptional<z.ZodString>;
                    appearance: z.ZodOptional<z.ZodEnum<{
                        compact: "compact";
                        detailed: "detailed";
                        cards: "cards";
                    }>>;
                }, z.core.$strip>>;
                label: z.ZodOptional<z.ZodString>;
                showLabel: z.ZodOptional<z.ZodBoolean>;
                order: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        colors: z.ZodOptional<z.ZodObject<{
            primary: z.ZodOptional<z.ZodString>;
            accent: z.ZodOptional<z.ZodString>;
            background: z.ZodOptional<z.ZodString>;
            border: z.ZodOptional<z.ZodString>;
            text: z.ZodOptional<z.ZodString>;
            muted: z.ZodOptional<z.ZodString>;
            success: z.ZodOptional<z.ZodString>;
            warning: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        styling: z.ZodOptional<z.ZodObject<{
            borderRadius: z.ZodOptional<z.ZodString>;
            padding: z.ZodOptional<z.ZodString>;
            gap: z.ZodOptional<z.ZodString>;
            fontSize: z.ZodOptional<z.ZodString>;
            fontWeight: z.ZodOptional<z.ZodString>;
            shadow: z.ZodOptional<z.ZodString>;
            fontFamily: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    isDefault: z.ZodDefault<z.ZodBoolean>;
    isPublic: z.ZodDefault<z.ZodBoolean>;
    workspaceId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const UpdateTemplateInputSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    config: z.ZodOptional<z.ZodObject<{
        layout: z.ZodOptional<z.ZodObject<{
            structure: z.ZodObject<{
                banner: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                header: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                sidebar: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                contentBefore: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                content: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                contentAfter: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
                footer: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodBoolean;
                    slots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    position: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                    }>>;
                    width: z.ZodOptional<z.ZodString>;
                    layout: z.ZodOptional<z.ZodEnum<{
                        horizontal: "horizontal";
                        vertical: "vertical";
                    }>>;
                    align: z.ZodOptional<z.ZodEnum<{
                        left: "left";
                        right: "right";
                        center: "center";
                    }>>;
                }, z.core.$strip>>;
            }, z.core.$strip>;
            fieldMapping: z.ZodRecord<z.ZodString, z.ZodObject<{
                slot: z.ZodString;
                renderer: z.ZodOptional<z.ZodObject<{
                    type: z.ZodEnum<{
                        number: "number";
                        text: "text";
                        date: "date";
                        link: "link";
                        relations: "relations";
                        badge: "badge";
                        avatar: "avatar";
                        progress: "progress";
                        checkbox: "checkbox";
                        currency: "currency";
                    }>;
                    variant: z.ZodOptional<z.ZodString>;
                    size: z.ZodOptional<z.ZodString>;
                    format: z.ZodOptional<z.ZodString>;
                    appearance: z.ZodOptional<z.ZodEnum<{
                        compact: "compact";
                        detailed: "detailed";
                        cards: "cards";
                    }>>;
                }, z.core.$strip>>;
                label: z.ZodOptional<z.ZodString>;
                showLabel: z.ZodOptional<z.ZodBoolean>;
                order: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        colors: z.ZodOptional<z.ZodObject<{
            primary: z.ZodOptional<z.ZodString>;
            accent: z.ZodOptional<z.ZodString>;
            background: z.ZodOptional<z.ZodString>;
            border: z.ZodOptional<z.ZodString>;
            text: z.ZodOptional<z.ZodString>;
            muted: z.ZodOptional<z.ZodString>;
            success: z.ZodOptional<z.ZodString>;
            warning: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        styling: z.ZodOptional<z.ZodObject<{
            borderRadius: z.ZodOptional<z.ZodString>;
            padding: z.ZodOptional<z.ZodString>;
            gap: z.ZodOptional<z.ZodString>;
            fontSize: z.ZodOptional<z.ZodString>;
            fontWeight: z.ZodOptional<z.ZodString>;
            shadow: z.ZodOptional<z.ZodString>;
            fontFamily: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    isDefault: z.ZodOptional<z.ZodBoolean>;
    isPublic: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const DuplicateTemplateInputSchema: z.ZodObject<{
    id: z.ZodString;
}, z.core.$strip>;
export declare const SetDefaultTemplateInputSchema: z.ZodObject<{
    id: z.ZodString;
}, z.core.$strip>;
export declare const DeleteTemplateInputSchema: z.ZodObject<{
    id: z.ZodString;
}, z.core.$strip>;
//# sourceMappingURL=schemas.d.ts.map