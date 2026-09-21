/**
 * market-scaffold.ts — the package SKELETON generator for the `market.scaffold`
 * builtin verb.
 *
 * WHY THIS IS A COPY, AND WHAT WAS DONE ABOUT IT
 * ----------------------------------------------
 * The CLI already has this logic (`synap-cli/src/lib/template-file.ts`
 * `scaffoldTemplateYaml`, `synap-cli/src/lib/kind-package.ts`
 * `scaffoldStandalonePackageJson`). Sharing it — rather than copying it — was the
 * preferred outcome and was checked first. It is not reachable from this repo:
 *
 *   • `synap-cli` is a SEPARATE repo/package; `@synap/api` does not and must not
 *     depend on the CLI (the CLI depends on the pod, not the reverse), and the
 *     CLI's copies are filesystem-coupled at the call site (`writeFileSync`,
 *     `process.exit`, `existsSync`).
 *   • The natural shared home IS `@synap-core/workspace-templates` — already a
 *     dependency of BOTH `@synap/api` and `synap-cli`. But this repo consumes it
 *     as a PUBLISHED registry tarball (resolved: `@synap-core+workspace-templates@0.11.0`,
 *     source lives in `synap-app/packages/workspace-templates`), and 0.11.0
 *     exports NO scaffold function (verified against its `dist/index.d.ts`
 *     export list). Moving the generator there means editing another repo and
 *     cutting a new npm version — out of reach of a backend-only change.
 *
 * So the duplicated surface is kept as SMALL as the shapes allow: only the
 * skeleton payloads, no file I/O, no CLI logging, no validate/publish hints.
 * The fields that LOOK cosmetic are load-bearing and are copied verbatim with
 * their reasons — a cell without `contentKind`/`viewTypes` and an automation
 * without `status`/`triggerType`/a real two-node flow install SILENTLY INERT.
 *
 * `skill` is deliberately NOT scaffoldable, matching the CLI: the Control Plane's
 * package schema has no standalone slot for a skill (skills only exist nested
 * inside a capability's `skills[]`), so a skeleton for one could never publish.
 */

/**
 * The package categories `market.scaffold` can generate.
 *
 * `workspace` is the workspace-TEMPLATE skeleton (a `.template.yaml`); the other
 * four are standalone package files (`.<kind>.json`) and mirror the CLI's
 * `SCAFFOLDABLE_KINDS` exactly. `skill` is absent on purpose — see the file
 * header.
 */
export const SCAFFOLDABLE_CATEGORIES = [
  "workspace",
  "cell",
  "view",
  "workflow",
  "capability",
] as const;
export type ScaffoldableCategory = (typeof SCAFFOLDABLE_CATEGORIES)[number];

/** Title-case a slug for a human-readable default name (`book-club` → `Book Club`). */
function slugToTitle(slug: string): string {
  return (
    slug
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || slug
  );
}

const PLACEHOLDER_COLOR = "#6B7280";

/** The minimal VALID workspace-template YAML — one workspace, one profile, one property. */
function scaffoldTemplateYaml(slug: string): string {
  const name = slugToTitle(slug);
  return `# ${name} — Synap workspace template
# Edit in place, then validate:  synap market validate ${slug}.template.yaml
# Publish (private by default):   synap market publish ${slug}.template.yaml
meta:
  slug: ${slug}
  name: ${name}
  description: A ${name} workspace.
  icon: "📦"
  color: "${PLACEHOLDER_COLOR}"

workspace:
  name: ${name}
  description: A ${name} workspace.

profiles:
  - slug: ${slug}-item
    displayName: ${name} Item
    properties:
      - slug: title
        label: Title
        valueType: string
`;
}

/**
 * The standalone-package payload for one kind.
 *
 * A `switch` over {@link ScaffoldableCategory} minus `workspace`, so a new
 * category cannot be added without an arm here (the `never` assignment below
 * is a typecheck failure, not a silent fallthrough).
 */
function scaffoldDefinition(
  kind: Exclude<ScaffoldableCategory, "workspace">,
  slug: string,
  displayName: string
): Record<string, unknown> {
  switch (kind) {
    case "cell":
      return {
        cells: [
          {
            key: slug,
            name: displayName,
            code: "export default function Cell() { return null; }",
            // NOT neutral: the CP schema strips an undeclared `contentKind`, so
            // the cell installs as the content-agnostic "widget" default and can
            // never be picked as a renderer for the kind it was built for.
            contentKind: "widget",
            // Without a view-type affinity the render chokepoint can never
            // select this cell — installed but permanently unpickable.
            viewTypes: ["list"],
          },
        ],
      };
    case "view":
      return {
        views: [{ slug, displayName, type: "list" }],
      };
    case "capability":
      return {
        capability: {
          key: slug,
          name: displayName,
          description: `What ${displayName} does — replace this before publishing.`,
          // The smallest immediately-usable capability is pure know-how: no
          // credential, no connection step. Add params/vault when a tool needs
          // a secret.
          params: [],
          vault: [],
          // `tools` and `skills` are REQUIRED on `CapabilityDefinition`
          // (@synap/playbooks); `tools: []` is legitimate and shipped.
          tools: [],
          skills: [
            {
              name: `${slug.replace(/-/g, "_")}_method`,
              // `instruction` = a prompt/doc skill injected into the agent's
              // turn — works on a fresh pod with no credentials, unlike `code`.
              kind: "instruction",
              scope: "pod",
              description: `When and how an agent should use ${displayName}.`,
              code: `# ${displayName}\n\nDescribe HOW the agent should do this — the judgement, not the mechanics.\n\n## When to use\n- Replace with the situations that should trigger this skill.\n\n## How to do it\n1. Replace with the actual method.\n\n## Hard rules\n- Replace with what the agent must never do here.\n`,
            },
          ],
        },
      };
    case "workflow":
      return {
        automations: [
          {
            // `slug` (not `key`): the CP publish schema resolves `slug ?? key`
            // but names `slug` first, and three templates once 400'd on
            // `automations.0.slug: Required`.
            slug,
            name: displayName,
            // `manual` is the only trigger inert until the author asks for it —
            // a scaffolded cron/event automation fires the moment it installs.
            triggerType: "manual",
            triggerConfig: {},
            // NOT neutral: the CP's automations[] transform defaults a missing
            // status to "draft", so it would install INERT with no signal.
            status: "active",
            // A real two-node flow: an empty flow is structurally valid and does
            // nothing, which is the "installed but does nothing" shape this
            // scaffold exists to avoid.
            flowDefinition: {
              nodes: [
                {
                  id: "trigger",
                  type: "trigger",
                  position: { x: 0, y: 0 },
                  data: {
                    label: displayName,
                    triggerType: "manual",
                    config: {},
                  },
                },
                {
                  id: "notify",
                  type: "output",
                  position: { x: 260, y: 0 },
                  data: {
                    label: "Notify",
                    outputType: "notification",
                    // `body` is required by the executor — a notification output
                    // with no body is SKIPPED at runtime.
                    config: { title: displayName, body: `${displayName} ran.` },
                  },
                },
              ],
              edges: [
                { id: "trigger-notify", source: "trigger", target: "notify" },
              ],
            },
          },
        ],
      };
    default: {
      const unhandled: never = kind;
      throw new Error(
        `market.scaffold: no skeleton for category ${String(unhandled)}`
      );
    }
  }
}

export interface ScaffoldSkeleton {
  /** The skeleton body, exactly as `synap market scaffold` would have written it to disk. */
  body: string;
  /** The filename the CLI would have used — kept so the two loops name the same artefact. */
  fileName: string;
  /** `text/yaml` for a workspace template, `application/json` otherwise. */
  documentType: "markdown" | "code";
  /** Human title for the persisted document. */
  title: string;
}

/**
 * Build the skeleton for one package `slug` + `category`. Pure: no disk, no
 * network. The caller persists it.
 */
export function buildPackageSkeleton(
  slug: string,
  category: ScaffoldableCategory
): ScaffoldSkeleton {
  const displayName = slugToTitle(slug);
  if (category === "workspace") {
    return {
      body: scaffoldTemplateYaml(slug),
      fileName: `${slug}.template.yaml`,
      documentType: "code",
      title: `${displayName} — workspace template skeleton`,
    };
  }
  const body =
    JSON.stringify(
      {
        category,
        slug,
        displayName,
        // No kind noun here on purpose: `cell` and `workflow` are MACHINE tokens
        // the product's vocabulary renders as "card" and "automation" — echoing
        // the raw token into a publishable description would fork that table.
        description: `What ${displayName} does — replace this before publishing.`,
        definition: scaffoldDefinition(category, slug, displayName),
      },
      null,
      2
    ) + "\n";
  return {
    body,
    fileName: `${slug}.${category}.json`,
    documentType: "code",
    title: `${displayName} — ${category} package skeleton`,
  };
}
