/**
 * `@synap-core/types/renderer-ref` — what a profile or workspace stores as its
 * renderer choice for a (content kind, profile) pair, and the bounded block
 * schema a `declarative` renderer carries.
 *
 * HOME. Before this module the type lived only in `@synap/database`
 * (`services/profile-resolution-service.ts`) and had drifted three ways
 * (backend 8 kinds, app-bases 7, Eve 5). Surfaces that DRAW a renderer —
 * pod-admin's `DeclarativeBlocks`, app-bases' renderer runtime — read it from
 * here. The pod keeps a structural copy because `@synap/database` cannot
 * depend on this package (types →(dev) database is the existing edge; the
 * reverse is a build cycle turbo refuses — see `grants/grammar.ts`).
 * `pod-parity.contract.ts` compiles the two against each other, so a member
 * added on one side only fails this package's typecheck.
 *
 * LEAF: pure types, no runtime imports.
 *
 * Stored as JSONB on `profiles.default_renderers` /
 * `renderer_bindings.ref` and inside `workspaces.settings.profileRenderers`.
 * Spec: synap-team-docs/content/team/platform/profile-renderer.mdx
 */

/**
 * A MINIMAL, bounded Block-Kit-style schema for a `declarative` renderer (the
 * config-first surface a capability page can carry without a coded cell or a
 * saved view). Intentionally small: five block kinds, each a plain data shape
 * any surface can render generically.
 */
export type DeclarativeBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "text"; text: string }
  | { type: "stat"; label: string; value: string | number; hint?: string }
  | { type: "list"; items: string[]; ordered?: boolean }
  | {
      type: "button";
      label: string;
      /** A capability verb key or a route the browser knows how to open. */
      action: string;
      params?: Record<string, unknown>;
    };

export type RendererRef =
  | {
      kind: "cell";
      cellKey: string;
      props: Record<string, unknown>;
      title?: string;
      displayMode?: string;
      rendererHint?: Record<string, unknown>;
    }
  | {
      kind: "view";
      viewId: string;
      title?: string;
      displayMode?: string;
    }
  | {
      kind: "iframe-srcdoc";
      appId: string;
      srcdoc: string;
      title?: string;
      props?: Record<string, unknown>;
    }
  | {
      kind: "external-app";
      appId: string;
      url: string;
      title?: string;
      props?: Record<string, unknown>;
    }
  | {
      kind: "url";
      url: string;
      external?: boolean;
      title?: string;
    }
  | {
      kind: "view-adapter";
      adapterKey: string;
      props?: Record<string, unknown>;
      title?: string;
    }
  | {
      kind: "declarative";
      schema: DeclarativeBlock[];
      title?: string;
      props?: Record<string, unknown>;
      displayMode?: string;
    }
  | {
      /**
       * "Open where it lives" (Places). Carries no url: the concrete target is
       * resolved per ENTITY on the pod from its `entity_external_links` row
       * (`resolveEntityOpenTarget`), so the binding only records the choice.
       */
      kind: "source-app";
      title?: string;
    };
