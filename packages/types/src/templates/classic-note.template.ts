import type { TemplateConfig } from "./types.js";

/**
 * Classic Note Template
 *
 * Use Case: Personal notes, documentation, drafts
 * Features: Status above title, clean sidebar, minimal distraction
 */
export const classicNoteTemplate: TemplateConfig = {
  layout: {
    structure: {
      header: {
        enabled: true,
        slots: ["statusRow", "title"],
        layout: "vertical",
        metadataPosition: "above",
        showIcon: false,
      },
      content: {
        enabled: true,
      },
      sidebar: {
        enabled: true,
        position: "right",
        width: "320px",
        slots: ["metadata"],
      },
    },
    fieldMapping: {
      status: {
        slot: "header.statusRow",
        renderer: { type: "badge", size: "sm", variant: "primary" },
        order: 1,
      },
      updatedAt: {
        slot: "header.statusRow",
        renderer: { type: "date", format: "datetime" },
        order: 2,
      },
      title: {
        slot: "header.title",
        renderer: { type: "text", variant: "heading1" },
      },

      createdAt: {
        slot: "sidebar.metadata",
        renderer: { type: "date", format: "long" },
        label: "Created",
        showLabel: true,
        order: 1,
      },
      lastUpdated: {
        slot: "sidebar.metadata",
        renderer: { type: "date", format: "relative" },
        label: "Last Updated",
        showLabel: true,
        order: 2,
      },
      version: {
        slot: "sidebar.metadata",
        renderer: { type: "badge", variant: "primary" },
        label: "Version",
        showLabel: true,
        order: 3,
      },
      documentId: {
        slot: "sidebar.metadata",
        renderer: { type: "code" },
        label: "Document ID",
        showLabel: true,
        order: 4,
      },
      tags: {
        slot: "sidebar.metadata",
        renderer: { type: "tags" },
        label: "Tags",
        showLabel: true,
        order: 5,
      },
    },
  },

  colors: {
    primary: "$primary",
    background: "$background",
    border: "$borderColor",
    text: "$color",
    muted: "$gray10",
  },

  viewOverrides: {
    modal: {
      structure: {
        sidebar: {
          enabled: false, // Hide sidebar in modal
        },
      },
    },
    panel: {
      structure: {
        sidebar: {
          enabled: false, // Hide sidebar in panel
        },
      },
    },
  },
};
