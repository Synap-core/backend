import type { TemplateConfig } from "./types.js";

/**
 * Wiki/Reference Template
 *
 * Use Case: Knowledge base, wikis, reference material
 * Features: Banner, metadata below title, backlinks, embedded views
 */
export const wikiReferenceTemplate: TemplateConfig = {
  layout: {
    structure: {
      banner: {
        enabled: true,
        slots: ["coverImage"],
      },
      header: {
        enabled: true,
        slots: ["title", "metadata"],
        layout: "vertical",
        metadataPosition: "below",
        showIcon: false,
      },
      content: {
        enabled: true,
      },
      sidebar: {
        enabled: true,
        position: "right",
        width: "288px",
        slots: ["linkedMentions", "outgoingLinks", "tableOfContents"],
      },
      contentAfter: {
        enabled: true,
        slots: ["embeddedGraph"],
      },
    },
    fieldMapping: {
      coverImage: {
        slot: "banner.coverImage",
        renderer: { type: "image", aspect: "wide" },
      },
      title: {
        slot: "header.title",
        renderer: { type: "text", variant: "heading1" },
      },
      createdAt: {
        slot: "header.metadata",
        renderer: { type: "date", format: "short" },
        label: "Created",
        order: 1,
      },
      updatedAt: {
        slot: "header.metadata",
        renderer: { type: "date", format: "relative" },
        label: "Last edited",
        order: 2,
      },
      contributors: {
        slot: "header.metadata",
        renderer: { type: "avatarGroup", size: "sm" },
        order: 3,
      },

      linkedMentions: {
        slot: "sidebar.linkedMentions",
        renderer: { type: "backlinks" },
      },
      outgoingLinks: {
        slot: "sidebar.outgoingLinks",
        renderer: { type: "links" },
      },
      tableOfContents: {
        slot: "sidebar.tableOfContents",
        renderer: { type: "toc" },
      },

      embeddedGraph: {
        slot: "contentAfter.embeddedGraph",
        renderer: { type: "embeddedView", variant: "graph" },
      },
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
        banner: {
          enabled: false, // No banner in modal
        },
        sidebar: {
          enabled: false, // Hide sidebar in modal
        },
        contentAfter: {
          enabled: false, // No embedded views in modal
        },
      },
    },
    panel: {
      structure: {
        banner: {
          enabled: false, // No banner in panel
        },
        sidebar: {
          enabled: false, // Hide sidebar in panel
        },
        contentAfter: {
          enabled: false, // No embedded views in panel
        },
      },
    },
  },
};
