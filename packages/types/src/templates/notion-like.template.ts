import type { TemplateConfig } from "./types.js";

/**
 * Notion-like Template
 *
 * Use Case: Working documents, tasks, projects with rich metadata
 * Features: Icon, inline badges, 2-column grid, relations, activity
 */
export const notionLikeTemplate: TemplateConfig = {
  layout: {
    structure: {
      header: {
        enabled: true,
        slots: ["icon", "title", "metadata"],
        layout: "horizontal",
        metadataPosition: "inline",
        showIcon: true,
      },
      contentBefore: {
        enabled: true,
        slots: ["propertiesGrid"],
      },
      content: {
        enabled: true,
      },
      contentAfter: {
        enabled: true,
        slots: ["relationships"],
      },
      footer: {
        enabled: true,
        slots: ["activity"],
      },
    },
    fieldMapping: {
      icon: {
        slot: "header.icon",
        renderer: { type: "icon", size: "lg" },
        order: 1,
      },
      title: {
        slot: "header.title",
        renderer: { type: "text", variant: "heading1" },
        order: 2,
      },
      status: {
        slot: "header.metadata",
        renderer: { type: "badge", variant: "blue", size: "sm" },
        order: 3,
      },
      id: {
        slot: "header.metadata",
        renderer: { type: "badge", variant: "gray", size: "sm" },
        order: 4,
      },
      priority: {
        slot: "header.metadata",
        renderer: { type: "badge", variant: "orange", size: "sm" },
        order: 5,
      },

      assignee: {
        slot: "contentBefore.propertiesGrid",
        renderer: { type: "avatar" },
        label: "Assignee",
        showLabel: true,
        order: 1,
      },
      dueDate: {
        slot: "contentBefore.propertiesGrid",
        renderer: { type: "date", format: "short" },
        label: "Due Date",
        showLabel: true,
        order: 2,
      },
      project: {
        slot: "contentBefore.propertiesGrid",
        renderer: { type: "link" },
        label: "Project",
        showLabel: true,
        order: 3,
      },
      tags: {
        slot: "contentBefore.propertiesGrid",
        renderer: { type: "tags" },
        label: "Tags",
        showLabel: true,
        order: 4,
      },

      relationships: {
        slot: "contentAfter.relationships",
        renderer: { type: "relations", appearance: "cards" },
      },

      activity: {
        slot: "footer.activity",
        renderer: { type: "timeline" },
      },
    },
  },

  styling: {
    contentBefore: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "$4",
    },
  },

  colors: {
    primary: "$primary",
    accent: "$accent",
    background: "$background",
    border: "$borderColor",
    text: "$color",
  },

  viewOverrides: {
    modal: {
      structure: {
        footer: {
          enabled: false, // Hide activity in modal for compactness
        },
      },
    },
    panel: {
      structure: {
        contentAfter: {
          enabled: false, // Hide relationships in panel
        },
        footer: {
          enabled: false, // Hide activity in panel
        },
      },
    },
  },
};
