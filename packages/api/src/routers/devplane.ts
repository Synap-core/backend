/**
 * DevPlane Router
 *
 * Provides DevPlane-specific procedures for bootstrapping DevPlane profiles
 * into a workspace. DevPlane uses Synap as its data layer.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import {
  ensureDevplaneProfiles,
  db,
  eq,
  and,
  desc,
  count,
  drizzleSql,
  workspaces,
} from "@synap/database";
import { entities, secrets } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  isVaultReference,
  parseVaultReference,
  resolveVaultSecret,
  VaultGrantError,
} from "../utils/vault-resolver.js";
import { encryptServerSide } from "@synap/database";

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface RecipeStep {
  name: string;
  command: string;
  continueOnError?: boolean;
}

export interface RunStep {
  name: string;
  command: string;
  status: "success" | "failed" | "skipped";
  exitCode: number;
  output: string;
  startedAt: string;
  finishedAt: string;
}

const logger = createLogger({ module: "devplane-router" });

export const devplaneRouter = router({
  /**
   * Bootstrap DevPlane profiles for the current workspace.
   *
   * Idempotent — safe to call multiple times. Creates the 6 DevPlane
   * entity profiles (app, feature, service, package, environment, deployment)
   * and their property definitions if they do not already exist.
   */
  bootstrap: workspaceProcedure
    .input(z.object({}).optional())
    .mutation(async ({ ctx }) => {
      logger.info(
        { workspaceId: ctx.workspaceId, userId: ctx.userId },
        "Bootstrapping DevPlane profiles"
      );

      const result = await ensureDevplaneProfiles();

      if (result.status === "error") {
        logger.error(
          { workspaceId: ctx.workspaceId, error: result.error },
          "Failed to bootstrap DevPlane profiles"
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: result.error ?? "Failed to bootstrap DevPlane profiles",
        });
      }

      logger.info(
        { workspaceId: ctx.workspaceId, result },
        "DevPlane profiles bootstrapped"
      );

      return {
        success: true,
        message: result.message,
        profilesCreated: result.profilesCreated,
        propertiesCreated: result.propertiesCreated,
        linksCreated: result.linksCreated,
      };
    }),

  /**
   * Get environment connection metadata for a devplane_environment entity.
   *
   * Returns host, SSH user, port, and whether an SSH key is configured.
   * The private key itself is never returned — it remains server-side only
   * and is resolved via the Vault during SSH proxy handshake.
   */
  getEnvironmentInfo: workspaceProcedure
    .input(z.object({ environmentEntityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.environmentEntityId),
          eq(entities.userId, ctx.userId)
        ),
        columns: { id: true, type: true, title: true, properties: true },
      });

      if (!entity) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Environment entity not found: ${input.environmentEntityId}`,
        });
      }

      if (entity.type !== "devplane_environment") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Entity is not a devplane_environment (got: ${entity.type})`,
        });
      }

      const props = (entity.properties ?? {}) as Record<string, unknown>;

      return {
        id: entity.id,
        name: entity.title ?? "Unnamed environment",
        host: (props["host"] as string | undefined) ?? null,
        port: 22,
        sshUser: (props["sshUser"] as string | undefined) ?? null,
        hasKey:
          typeof props["sshKeyVaultRef"] === "string" &&
          isVaultReference(props["sshKeyVaultRef"] as string),
      };
    }),

  /**
   * Fetch a devplane_recipe entity and return its typed step list.
   */
  getRecipe: workspaceProcedure
    .input(z.object({ recipeEntityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.recipeEntityId),
          eq(entities.userId, ctx.userId)
        ),
        columns: { id: true, type: true, title: true, properties: true },
      });

      if (!entity) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Recipe entity not found: ${input.recipeEntityId}`,
        });
      }

      if (entity.type !== "devplane_recipe") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Entity is not a devplane_recipe (got: ${entity.type})`,
        });
      }

      const props = (entity.properties ?? {}) as Record<string, unknown>;

      let steps: RecipeStep[] = [];
      const rawSteps = props["recipeSteps"] as string | undefined;
      if (rawSteps) {
        try {
          steps = JSON.parse(rawSteps) as RecipeStep[];
        } catch {
          logger.warn(
            { entityId: entity.id },
            "Could not parse recipeSteps JSON"
          );
        }
      }

      return {
        id: entity.id,
        title: entity.title ?? "Unnamed Recipe",
        recipeName: (props["recipeName"] as string | undefined) ?? null,
        recipeDescription:
          (props["recipeDescription"] as string | undefined) ?? null,
        steps,
        linkedEnvironmentId:
          (props["linkedEnvironmentId"] as string | undefined) ?? null,
        linkedAppSlug: (props["linkedAppSlug"] as string | undefined) ?? null,
        onFailure:
          (props["onFailure"] as
            | "stop"
            | "continue"
            | "rollback"
            | undefined) ?? "stop",
        rollbackRecipeId:
          (props["rollbackRecipeId"] as string | undefined) ?? null,
        recipeTemplate:
          (props["recipeTemplate"] as
            | "kamal"
            | "docker-compose"
            | "git-pull"
            | "custom"
            | undefined) ?? null,
      };
    }),

  /**
   * List devplane_recipe_run entities for the current workspace, optionally
   * filtered by recipeId. Returns runs sorted by runStartedAt descending.
   */
  listRecipeRuns: workspaceProcedure
    .input(z.object({ recipeId: z.string().uuid().optional() }))
    .query(async ({ ctx, input }) => {
      const rows = await db.query.entities.findMany({
        where: and(
          eq(entities.type, "devplane_recipe_run"),
          eq(entities.userId, ctx.userId)
        ),
        columns: {
          id: true,
          title: true,
          properties: true,
          createdAt: true,
        },
        orderBy: [desc(entities.createdAt)],
      });

      const runs = rows
        .map((row) => {
          const props = (row.properties ?? {}) as Record<string, unknown>;

          let runSteps: RunStep[] = [];
          const rawRunSteps = props["runSteps"] as string | undefined;
          if (rawRunSteps) {
            try {
              runSteps = JSON.parse(rawRunSteps) as RunStep[];
            } catch {
              // malformed JSON — skip
            }
          }

          return {
            id: row.id,
            title: row.title ?? "Recipe Run",
            recipeId: (props["recipeId"] as string | undefined) ?? null,
            runStatus:
              (props["runStatus"] as
                | "running"
                | "success"
                | "failed"
                | "cancelled"
                | undefined) ?? null,
            runSteps,
            runStartedAt: (props["runStartedAt"] as string | undefined) ?? null,
            runFinishedAt:
              (props["runFinishedAt"] as string | undefined) ?? null,
            runDuration:
              typeof props["runDuration"] === "number"
                ? (props["runDuration"] as number)
                : null,
            triggeredBy:
              (props["triggeredBy"] as "manual" | "automation" | undefined) ??
              "manual",
            createdAt: row.createdAt,
          };
        })
        .filter((run) => {
          if (input.recipeId) {
            return run.recipeId === input.recipeId;
          }
          return true;
        })
        .sort((a, b) => {
          const aTime = a.runStartedAt ? new Date(a.runStartedAt).getTime() : 0;
          const bTime = b.runStartedAt ? new Date(b.runStartedAt).getTime() : 0;
          return bTime - aTime;
        });

      return runs;
    }),

  /**
   * Seed Synap project data into DevPlane.
   *
   * Creates apps, services, packages, features, environments, and recipes
   * that represent the real Synap infrastructure. Idempotent — skips if
   * devplane_app entities already exist.
   */
  seedSynapProjectData: workspaceProcedure
    .input(z.object({}).optional())
    .mutation(async ({ ctx }) => {
      const existing = await db
        .select({ n: count() })
        .from(entities)
        .where(
          and(
            eq(entities.type, "devplane_app"),
            eq(entities.userId, ctx.userId)
          )
        );

      if ((existing[0]?.n ?? 0) > 0) {
        return { seeded: false, message: "Synap project data already exists" };
      }

      const now = new Date();
      const ws = ctx.workspaceId;
      const uid = ctx.userId;

      const ins = (
        type: string,
        title: string,
        props: Record<string, unknown>
      ) =>
        db.insert(entities).values({
          id: crypto.randomUUID(),
          userId: uid,
          workspaceId: ws,
          profileId: null,
          type,
          title,
          properties: props,
          createdAt: now,
          updatedAt: now,
        });

      // ── Apps ──────────────────────────────────────────────────────────────
      await ins("devplane_app", "synap-backend", {
        appName: "synap-backend",
        repoUrl: "https://github.com/synap-core/synap-backend",
        techStack: "Node.js, Hono, tRPC, Drizzle ORM, PostgreSQL, pg-boss",
        port: 4000,
        deployUrl: "https://api.synap.live",
        appDescription:
          "Data Pod API — tRPC routers, Hub Protocol REST, Drizzle schema, pg-boss workers, Socket.IO realtime",
      });
      await ins("devplane_app", "synap-app", {
        appName: "synap-app",
        repoUrl: "https://github.com/synap-core/synap-app",
        techStack:
          "React 19, Tamagui, TanStack Query, Zustand, tRPC 11, pnpm monorepo, Turbo",
        port: 3000,
        appDescription:
          "Frontend monorepo — Hub OS, Studio, Base template, CRM, DevPlane, and all core/feature/view packages",
      });
      await ins("devplane_app", "synap-intelligence-service", {
        appName: "synap-intelligence-service",
        repoUrl: "https://github.com/synap-core/synap-intelligence-service",
        techStack:
          "Node.js, OrchestratorAgent, PersonaAgent, OpenRouter, Langfuse",
        port: 3001,
        deployUrl: "https://ai.synap.live",
        appDescription:
          "AI Agent Hub — OrchestratorAgent + PersonaAgents, Hub Protocol client, session-scoped memory, 21 sub-routers",
      });
      await ins("devplane_app", "browser", {
        appName: "browser",
        repoUrl: "https://github.com/synap-core/browser",
        techStack: "Electron, React 19, Tamagui, Vite, electron-builder",
        appDescription:
          "Primary desktop app — 18 apps, bento dashboard, sidebar, entity panel, AI chat, command palette",
      });
      await ins("devplane_app", "relay-app", {
        appName: "relay-app",
        repoUrl: "https://github.com/synap-core/relay-app",
        techStack: "Expo, React Native, Tamagui, TanStack Query",
        appDescription:
          "Consumer mobile app — capture, proactive feed, personal AI, 5 automation templates, native OS integrations",
      });
      await ins("devplane_app", "synap-control-plane-api", {
        appName: "synap-control-plane-api",
        repoUrl: "https://github.com/synap-core/synap-control-plane-api",
        techStack: "Node.js, Hono REST, PostgreSQL, Trigger.dev, Better Auth",
        port: 3000,
        deployUrl: "https://api.synap.live",
        appDescription:
          "SaaS control plane — pod provisioning, billing, tenant management, CP↔Pod ES256 JWT auth",
      });
      await ins("devplane_app", "synap-control-plane-dashboard", {
        appName: "synap-control-plane-dashboard",
        repoUrl: "https://github.com/synap-core/synap-control-plane-dashboard",
        techStack: "React, Vite, TypeScript",
        port: 5173,
        deployUrl: "https://dashboard.synap.live",
        appDescription:
          "Admin dashboard — pod lifecycle, tenant management, shared pod monitoring, marketplace packs",
      });
      await ins("devplane_app", "synap-cli", {
        appName: "synap-cli",
        repoUrl: "https://github.com/synap-core/synap-cli",
        techStack: "Node.js, Commander.js",
        appDescription:
          "npx @synap/cli init — three-path flow: connect existing OpenClaw, fresh server, or laptop. Provisions agent + API key via Hub Protocol.",
      });

      // ── Services ──────────────────────────────────────────────────────────
      await ins("devplane_service", "PostgreSQL (TimescaleDB 15)", {
        serviceType: "database",
        servicePort: 5432,
        healthUrl: "postgresql://synap:***@localhost:5432/synap",
      });
      await ins("devplane_service", "Redis", {
        serviceType: "cache",
        servicePort: 6379,
      });
      await ins("devplane_service", "MinIO", {
        serviceType: "storage",
        servicePort: 9000,
        healthUrl: "http://localhost:9000/minio/health/live",
      });
      await ins("devplane_service", "Typesense", {
        serviceType: "search",
        servicePort: 8108,
        healthUrl: "http://localhost:8108/health",
      });
      await ins("devplane_service", "Kratos", {
        serviceType: "auth",
        servicePort: 4433,
        healthUrl: "http://localhost:4433/health/alive",
      });
      await ins("devplane_service", "Hydra", {
        serviceType: "oauth2",
        servicePort: 4444,
        healthUrl: "http://localhost:4444/health/alive",
      });
      await ins("devplane_service", "Caddy", {
        serviceType: "reverse-proxy",
        servicePort: 443,
      });
      await ins("devplane_service", "RSSHub", {
        serviceType: "rss",
        servicePort: 1200,
        healthUrl: "http://localhost:1200/healthz",
      });
      await ins("devplane_service", "Dozzle", {
        serviceType: "logs",
        servicePort: 8080,
      });
      await ins("devplane_service", "Prometheus + Grafana", {
        serviceType: "monitoring",
        servicePort: 9090,
        healthUrl: "http://localhost:9090/-/healthy",
      });

      // ── Packages ──────────────────────────────────────────────────────────
      const pkgs: Array<[string, string, string]> = [
        // Backend
        [
          "@synap/api",
          "1.0.0",
          "tRPC routers, Hub Protocol REST handlers, vault resolver, SSH proxy, recipe runner",
        ],
        [
          "@synap/database",
          "0.1.1",
          "Drizzle schema + migrations, repositories, ProfileResolutionService, pg client",
        ],
        [
          "@synap/auth",
          "1.0.0",
          "Kratos session client — getKratosSession, getKratosSessionByToken, identity management",
        ],
        [
          "@synap/jobs",
          "1.0.0",
          "pg-boss workers — 27 workers + 3 proactive cron jobs (morning briefing, weekly digest, health check)",
        ],
        [
          "@synap/events",
          "1.0.0",
          "Typed event chain — 13 event types, delivery router, AutomationTriggerConfig",
        ],
        [
          "@synap/realtime",
          "1.0.0",
          "Socket.IO server + Yjs CRDT document sync, presence, collaborative editing",
        ],
        [
          "@synap/search",
          "1.0.0",
          "Typesense client — full-text search, entity indexing, collection management",
        ],
        [
          "@synap/storage",
          "1.0.0",
          "MinIO client — file upload/download, presigned URLs, bucket management",
        ],
        [
          "@synap/ai",
          "1.0.0",
          "AI pipeline — embedding generation, pgvector semantic search, classification",
        ],
        [
          "@synap/feed-service",
          "1.0.0",
          "RSS feed aggregation, content parsing, feed worker",
        ],
        [
          "@synap-core/hub-protocol",
          "1.0.0",
          "Hub Protocol types — 21 sub-router contracts between IS and backend",
        ],
        [
          "@synap/agent-sdk",
          "1.0.0",
          "Agent SDK — PodClient, IS HTTP contract, tool execution helpers",
        ],
        // App core
        [
          "@synap-core/ui-system",
          "1.0.0",
          "Tamagui design system — tokens, primitives (Button, Input, Card), dark/light themes, Fraunces + DM Sans",
        ],
        [
          "@synap-core/cell-runtime",
          "1.0.0",
          "Cell registry singleton + CellRenderer dispatcher — BentoCellHost, PanelCellHost, PageCellHost",
        ],
        [
          "@synap-core/capabilities",
          "1.0.0",
          "Widget types manifest — 60+ built-in cells, view type definitions, contracts",
        ],
        [
          "@synap-core/channels",
          "1.0.0",
          "Channel system — 6 types (ai_thread, branch, entity_comments, document_review, view_discussion, direct)",
        ],
        [
          "@synap-core/document",
          "1.0.0",
          "Document editor — Tiptap 3 / ProseMirror, collaborative editing, slash commands",
        ],
        [
          "@synap-core/notifications",
          "1.0.0",
          "Notification system — 27 types, NotificationBell, toast provider, lifecycle management",
        ],
        [
          "@synap-core/template-engine",
          "1.0.0",
          "Workspace templates — 6 presets (second-brain, agent-fleet, startup-os…), mergePresetAndAddons",
        ],
        [
          "@synap-core/connectors",
          "1.0.0",
          "Nango OAuth connectors — 39 integrations, CP→Pod pull-sync",
        ],
        [
          "@synap-core/marketplace",
          "1.0.0",
          "CP marketplace browser — search, category tabs, install pipeline, 13 pack types",
        ],
        [
          "@synap-core/native-os",
          "1.0.0",
          "Native OS umbrella — 7 sub-packages: shared-storage, share, spotlight, intents, widgets, live-updates, vision",
        ],
        // App features
        [
          "@synap-core/ai-chat",
          "1.0.0",
          "AI chat UI — SSE streaming, branch management, context items, history compaction",
        ],
        [
          "@synap-core/capture-pipeline",
          "1.0.0",
          "Shared capture types, CaptureClient adapter, AI enrichment, 7 capture surfaces",
        ],
        [
          "@synap-core/onboarding",
          "1.0.0",
          "Story-based onboarding — StoryOnboardingFlow, 6 presets, 10 feature addons, BrowserNewSpaceDialog",
        ],
        [
          "@synap-core/proposals",
          "1.0.0",
          "Governance proposals UI — ProposalsList, ProposalDetail, timeline, inbox integration",
        ],
        [
          "@synap-core/workflows",
          "1.0.0",
          "Automations + commands — flow editor, trigger→step chain, sandbox execution",
        ],
        [
          "@synap-core/whiteboard",
          "1.0.0",
          "Entity-aware spatial canvas — tldraw 2.0, entity pins, collaborative cursors",
        ],
        [
          "@synap-core/intelligence",
          "1.0.0",
          "Intelligence app — agent detail, usage stats, skills list, proposals badge, recent chats",
        ],
        [
          "@synap/extension",
          "1.0.0",
          "Chrome MV3 browser extension — Side Panel API, tab import, quick capture, Hub Protocol client",
        ],
        // Views
        [
          "@synap/view-bento",
          "1.0.0",
          "Bento dashboard — 12-col react-grid-layout, 22 widget types, edit mode, widget error boundaries",
        ],
        [
          "@synap/view-kanban",
          "1.0.0",
          "Kanban view — drag-drop, swimlanes, groupBy field, FieldRenderer",
        ],
        [
          "@synap/view-calendar",
          "1.0.0",
          "Calendar view — month/week/day modes, event drag-drop, recurring events",
        ],
        [
          "@synap/view-table",
          "1.0.0",
          "Table view — sortable columns, inline editing, filter bar, bulk actions",
        ],
        [
          "@synap/view-timeline",
          "1.0.0",
          "Timeline view — Gantt-like, date ranges, dependency lines (planned)",
        ],
        [
          "@synap/view-graph",
          "1.0.0",
          "Graph view — force/tree/radial layouts, entity relationships, D3",
        ],
      ];

      for (const [name, version, description] of pkgs) {
        await ins("devplane_package", name, {
          packageName: name,
          packageVersion: version,
          description,
        });
      }

      // ── Features ──────────────────────────────────────────────────────────
      const features: Array<[string, string, string, string]> = [
        // [title, status, linkedAppSlugs, description]
        [
          "AI Chat",
          "done",
          "synap-app,browser,relay-app",
          "SSE streaming chat with OrchestratorAgent + PersonaAgents, branch management, context items, history compaction at 12k tokens",
        ],
        [
          "Whiteboard",
          "done",
          "browser",
          "Entity-aware spatial canvas using tldraw 2.0 — pin entities, draw freely, collaborative cursors via Yjs",
        ],
        [
          "Kanban View",
          "done",
          "synap-app,browser",
          "Grouped entity list with drag-drop, swimlanes, groupBy any property, FieldRenderer cards",
        ],
        [
          "Calendar View",
          "done",
          "synap-app,browser",
          "Month/week/day calendar for event entities — drag-drop, recurring events, dateRange properties",
        ],
        [
          "Bento Dashboard",
          "done",
          "synap-app,browser",
          "12-col react-grid-layout dashboard — 22 widget types, edit mode, per-entity dashboards, AI-composable",
        ],
        [
          "Table View",
          "done",
          "synap-app,browser",
          "Sortable/filterable table — inline editing, bulk actions, column resize, FieldRenderer cells",
        ],
        [
          "Graph View",
          "done",
          "synap-app,browser",
          "Knowledge graph visualization — force/tree/radial layouts, typed relationships, D3",
        ],
        [
          "Document Editor",
          "done",
          "synap-app,browser",
          "Tiptap 3 / ProseMirror editor — slash commands, collaborative editing via Yjs, entity embeds",
        ],
        [
          "Capture Pipeline",
          "done",
          "browser,relay-app,synap-app",
          "7-surface unified capture — AI classifies + enriches entities, streaming, HTML parsing, refine flow",
        ],
        [
          "Story Onboarding",
          "done",
          "browser,relay-app",
          "StoryOnboardingFlow — 6 presets + 10 feature addons → workspace proposal creation",
        ],
        [
          "Proposals & Governance",
          "done",
          "synap-app,browser",
          "AI writes → checkPermissionOrPropose → user approves. Event chain, audit log, auto-approve whitelist",
        ],
        [
          "Workflows & Automations",
          "done",
          "synap-app,browser",
          "Trigger→step chain with 5 node types — entity triggers, skill steps, condition branches, vault resolution",
        ],
        [
          "Notifications",
          "done",
          "synap-app,browser,relay-app",
          "27 registry types — NotificationBell, toast, banner, lifecycle (actioned on approve/reject), proactive integration",
        ],
        [
          "Connectors (Nango)",
          "in-progress",
          "synap-app",
          "39 OAuth integrations via Nango self-hosted — CP→Pod pull-sync, source tracking on entities",
        ],
        [
          "Marketplace",
          "done",
          "browser",
          "CP marketplace — 13 pack types (10 profile + 3 view), composesFrom resolution, install pipeline",
        ],
        [
          "Browser Extension",
          "done",
          "synap-app",
          "Chrome MV3 Side Panel — tab import onboarding, quick capture, Hub Protocol REST client, service worker auth",
        ],
        [
          "Relay Mobile App",
          "done",
          "relay-app",
          "Expo RN — 3-surface feed model (personal chat/proactive feed/notifications), 5 automation templates",
        ],
        [
          "DevPlane",
          "in-progress",
          "devplane",
          "Infra management app — apps, services, packages, environments, SSH terminal, recipe runner, prompt snippets",
        ],
        [
          "MCP Integration",
          "in-progress",
          "synap-intelligence-service,browser",
          "MCP server support — hidden from default UX, adminOnly gate in settings, tool discovery",
        ],
        [
          "Background Agents",
          "in-progress",
          "synap-intelligence-service",
          "Long-running autonomous agents — heartbeat, pg-boss orchestration, proactive intelligence layer",
        ],
        [
          "Native OS Integrations",
          "in-progress",
          "relay-app",
          "7 sub-packages — share sheet, Spotlight search, home screen widgets, Live Activities, vision capture",
        ],
        [
          "Timeline View",
          "planned",
          "synap-app,browser",
          "Gantt-like timeline — date ranges, dependency lines, groupBy, milestone markers",
        ],
      ];

      for (const [title, status, linkedApps, desc] of features) {
        // linkedApps is comma-separated; store the first as linkedApp (primary)
        const linkedApp = linkedApps.split(",")[0]?.trim() ?? "";
        const linkedPackages = "";
        await ins("devplane_feature", title, {
          featureStatus: status,
          linkedApp,
          linkedPackages,
          description: desc,
        });
      }

      // ── Environments (host intentionally blank — fill in via UI) ────────
      await ins("devplane_environment", "Production Pod", {
        envType: "production",
        linkedAppSlug: "synap-backend",
        isActive: true,
      });
      await ins("devplane_environment", "Intelligence Service", {
        envType: "production",
        linkedAppSlug: "synap-intelligence-service",
        isActive: true,
      });
      await ins("devplane_environment", "Control Plane", {
        envType: "production",
        linkedAppSlug: "synap-control-plane-api",
        isActive: true,
      });
      await ins("devplane_environment", "Local Dev", {
        envType: "development",
        isActive: false,
      });

      // ── Recipes ───────────────────────────────────────────────────────────
      await ins("devplane_recipe", "Deploy Data Pod", {
        recipeName: "Deploy Data Pod",
        recipeDescription:
          "Pull new backend image, run DB migrations, canary-validate, then swap production. Uses update-pod.sh canary-first strategy.",
        recipeTemplate: "docker-compose",
        onFailure: "stop",
        recipeSteps: JSON.stringify([
          {
            name: "Pull images",
            command:
              "docker compose -p synap-backend -f deploy/docker-compose.yml pull backend realtime backend-migrate",
          },
          {
            name: "Run migrations",
            command:
              "docker compose -p synap-backend -f deploy/docker-compose.yml run --rm backend-migrate",
          },
          {
            name: "Full canary update",
            command: "./deploy/update-pod.sh latest",
          },
          {
            name: "Health check",
            command:
              "wget -q -O /dev/null --timeout=10 http://localhost:4000/health && echo 'OK'",
          },
        ]),
      });
      await ins("devplane_recipe", "Deploy Intelligence Service", {
        recipeName: "Deploy Intelligence Service",
        recipeDescription:
          "Pull IS Docker image, run migrations, restart service, verify health endpoint.",
        recipeTemplate: "docker-compose",
        onFailure: "stop",
        recipeSteps: JSON.stringify([
          {
            name: "Pull image",
            command: "docker compose pull --ignore-pull-failures",
          },
          {
            name: "Run migrations",
            command: "docker compose run --rm --no-deps intelligence-migrate",
          },
          {
            name: "Restart service",
            command:
              "docker compose --profile standalone up -d --force-recreate --no-deps intelligence-service",
          },
          {
            name: "Health check",
            command:
              "docker compose exec -T intelligence-service wget -qO- http://127.0.0.1:3001/health",
          },
        ]),
      });
      await ins("devplane_recipe", "Deploy Control Plane", {
        recipeName: "Deploy Control Plane",
        recipeDescription:
          "Build CP Docker image from latest git, run migrations, redeploy API container.",
        recipeTemplate: "docker-compose",
        onFailure: "stop",
        recipeSteps: JSON.stringify([
          { name: "Pull latest code", command: "git pull" },
          {
            name: "Build Docker image",
            command: "docker build -t synap-control-plane:latest .",
          },
          { name: "Run migrations", command: "./synap-cp migrate" },
          {
            name: "Redeploy API",
            command:
              "docker compose -f docker-compose.prod.yml up -d --force-recreate api",
          },
          { name: "Health check", command: "./synap-cp health" },
        ]),
      });
      await ins("devplane_recipe", "Run DB Migrations", {
        recipeName: "Run DB Migrations",
        recipeDescription:
          "Pull migrate image and run pending Drizzle migrations on the pod database.",
        recipeTemplate: "docker-compose",
        onFailure: "stop",
        recipeSteps: JSON.stringify([
          {
            name: "Pull migrate image",
            command: "docker compose pull backend-migrate",
          },
          {
            name: "Run migrations",
            command: "docker compose run --rm backend-migrate",
          },
        ]),
      });
      await ins("devplane_recipe", "Build Browser App", {
        recipeName: "Build Browser App",
        recipeDescription:
          "Build Electron desktop app distributables for all platforms.",
        recipeTemplate: "custom",
        onFailure: "continue",
        recipeSteps: JSON.stringify([
          {
            name: "Install dependencies",
            command: "pnpm install --frozen-lockfile",
          },
          { name: "Build Mac", command: "pnpm dist:mac" },
          {
            name: "Build Windows",
            command: "pnpm dist:win",
            continueOnError: true,
          },
        ]),
      });
      await ins("devplane_recipe", "Health Check All Services", {
        recipeName: "Health Check All Services",
        recipeDescription:
          "Verify all production services are responding. Runs checks in sequence — stops on first failure.",
        recipeTemplate: "custom",
        onFailure: "continue",
        recipeSteps: JSON.stringify([
          {
            name: "Pod API",
            command:
              "wget -q -O /dev/null --timeout=5 http://localhost:4000/health && echo 'Pod: OK'",
          },
          {
            name: "Intelligence Service",
            command:
              "wget -qO- --timeout=5 http://localhost:3001/health && echo 'IS: OK'",
          },
          { name: "Control Plane", command: "./synap-cp health" },
          {
            name: "Typesense",
            command: "wget -qO- --timeout=5 http://localhost:8108/health",
          },
          {
            name: "MinIO",
            command:
              "wget -qO- --timeout=5 http://localhost:9000/minio/health/live && echo 'MinIO: OK'",
          },
        ]),
      });

      logger.info(
        { workspaceId: ctx.workspaceId },
        "Seeded Synap project data into DevPlane"
      );

      return {
        seeded: true,
        counts: {
          apps: 8,
          services: 10,
          packages: pkgs.length,
          features: features.length,
          environments: 4,
          recipes: 6,
        },
      };
    }),

  /**
   * Seed default prompt snippets for the current workspace.
   *
   * Idempotent — checks if any snippets already exist before creating.
   * Called once on first login from the DevPlane frontend.
   */
  seedDefaultSnippets: workspaceProcedure
    .input(z.object({}).optional())
    .mutation(async ({ ctx }) => {
      // Check if snippets already exist for this workspace
      const existing = await db
        .select({ n: count() })
        .from(entities)
        .where(
          and(
            eq(entities.type, "devplane_prompt_snippet"),
            eq(entities.userId, ctx.userId)
          )
        );

      if ((existing[0]?.n ?? 0) > 0) {
        return { seeded: false, message: "Snippets already exist" };
      }

      const defaults: Array<{
        title: string;
        category: string;
        description: string;
        body: string;
      }> = [
        // Deploy
        {
          title: "Deploy app to environment",
          category: "deploy",
          description: "General app deployment with health check",
          body: "Deploy @{arg:app} to @{arg:environment}. Check health endpoints after deploy and report status.",
        },
        {
          title: "Kamal deploy with rollback",
          category: "deploy",
          description: "Zero-downtime deploy via Kamal",
          body: "Run Kamal deploy for @{arg:app} on @{arg:environment}. If health check fails, trigger rollback and report what went wrong.",
        },
        {
          title: "Check deployment status",
          category: "deploy",
          description: "Inspect deployment health and recent logs",
          body: "Check the latest deployment of @{arg:app} on @{arg:environment}. Report any failures, restarts, or warnings in the logs.",
        },
        // Debug
        {
          title: "Debug production error",
          category: "debug",
          description: "Root cause analysis for production errors",
          body: "I'm seeing this error in production on @{arg:service}:\n\n@{arg:error}\n\nWhat are the most likely root causes and debugging steps?",
        },
        {
          title: "Analyze logs",
          category: "debug",
          description: "Parse and interpret service logs",
          body: "Analyze these logs from @{arg:service}:\n\n@{arg:logs}\n\nIdentify errors, warnings, and anomalies. Suggest fixes for each issue.",
        },
        // Test
        {
          title: "Write test cases",
          category: "test",
          description: "Generate test suite for a feature",
          body: "Write comprehensive test cases for @{arg:feature} in @{arg:app}. Include unit tests, edge cases, and failure scenarios.",
        },
        {
          title: "Review test coverage",
          category: "test",
          description: "Identify coverage gaps and untested paths",
          body: "Review test coverage for @{arg:component}. Identify gaps, suggest additional tests, and flag any untested critical paths.",
        },
        // Audit
        {
          title: "Security audit",
          category: "audit",
          description: "Security vulnerability check (OWASP top 10)",
          body: "Perform a security audit of @{arg:component} in @{arg:app}. Check for common vulnerabilities (OWASP top 10), secrets exposure, and injection risks.",
        },
        {
          title: "Performance audit",
          category: "audit",
          description: "Performance bottleneck and N+1 analysis",
          body: "Audit the performance of @{arg:feature} in @{arg:app}. Identify bottlenecks, N+1 queries, and memory leaks. Suggest optimizations.",
        },
        {
          title: "Dependency audit",
          category: "audit",
          description: "Check for CVEs and outdated packages",
          body: "Audit dependencies of @{arg:package}. Identify outdated packages, known CVEs, and unused dependencies. Suggest updates or replacements.",
        },
        // Review
        {
          title: "Code review",
          category: "review",
          description: "Thorough code review with actionable feedback",
          body: "Review the implementation of @{arg:feature} in @{arg:app}. Check for bugs, code quality issues, and adherence to best practices. Be specific.",
        },
        {
          title: "Architecture review",
          category: "review",
          description: "Architecture and design quality review",
          body: "Review the architecture of @{arg:service}. Evaluate scalability, separation of concerns, failure modes, and suggest improvements.",
        },
      ];

      const now = new Date();
      for (const s of defaults) {
        await db.insert(entities).values({
          id: crypto.randomUUID(),
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          profileId: null,
          type: "devplane_prompt_snippet",
          title: s.title,
          properties: {
            snippetTitle: s.title,
            snippetCategory: s.category,
            snippetDescription: s.description,
            snippetBody: s.body,
          },
          createdAt: now,
          updatedAt: now,
        });
      }

      logger.info(
        { workspaceId: ctx.workspaceId, count: defaults.length },
        "Seeded default DevPlane snippets"
      );

      return { seeded: true, count: defaults.length };
    }),

  /**
   * Save an AI provider API key for terminal env injection.
   *
   * Stores the key in a server-side vault secret and saves the vault reference
   * (never the plaintext key) in workspace settings under:
   *   settings.devplane.providers.{providerType}.apiKeyVaultRef
   *
   * Provider types and their PTY env vars:
   *   anthropic   → ANTHROPIC_API_KEY
   *   openrouter  → OPENROUTER_API_KEY
   *   openai      → OPENAI_API_KEY
   */
  saveProviderApiKey: workspaceProcedure
    .input(
      z.object({
        providerType: z.enum(["anthropic", "openrouter", "openai"]),
        apiKey: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const blob = encryptServerSide(input.apiKey);
      const secretName = `devplane_provider_${input.providerType}_${ctx.workspaceId}`;

      const existing = await db.query.secrets.findFirst({
        where: and(
          eq(secrets.userId, ctx.userId),
          eq(secrets.name, secretName)
        ),
        columns: { id: true },
      });

      let secretId: string;
      if (existing) {
        await db
          .update(secrets)
          .set({
            encryptedData: blob.encryptedData,
            iv: blob.iv,
            authTag: blob.authTag,
            updatedAt: new Date(),
          })
          .where(eq(secrets.id, existing.id));
        secretId = existing.id;
      } else {
        secretId = crypto.randomUUID();
        await db.insert(secrets).values({
          id: secretId,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          name: secretName,
          type: "api_key",
          encryptedData: blob.encryptedData,
          iv: blob.iv,
          authTag: blob.authTag,
          encryptionMode: "server",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Store vault ref namespaced by userId so each workspace member has independent keys
      const vaultRef = `vault://${secretId}`;
      await db
        .update(workspaces)
        .set({
          settings: drizzleSql`settings || jsonb_build_object(
            'devplane', COALESCE(settings->'devplane', '{}'::jsonb) || jsonb_build_object(
              'userProviders', COALESCE(settings->'devplane'->'userProviders', '{}'::jsonb) || jsonb_build_object(
                ${ctx.userId}, COALESCE(settings->'devplane'->'userProviders'->${ctx.userId}, '{}'::jsonb) || jsonb_build_object(
                  ${input.providerType}, jsonb_build_object('apiKeyVaultRef', ${vaultRef}::text)
                )
              )
            )
          )`,
        })
        .where(eq(workspaces.id, ctx.workspaceId));

      logger.info(
        {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          providerType: input.providerType,
        },
        "Provider API key saved"
      );

      return { ok: true };
    }),

  /**
   * Save a vault-backed secret for a DevPlane entity property.
   *
   * Encrypts server-side, upserts into the secrets table, and writes the
   * `vault://uuid` reference back into the entity's JSONB properties.
   * Returns the vault ref so the frontend can confirm the value was stored.
   *
   * Supported property slugs:
   *   sshKeyVaultRef       — devplane_environment SSH private key
   *   npmTokenVaultRef     — devplane_app NPM publish token
   *   githubTokenVaultRef  — devplane_app GitHub personal access token
   */
  saveEntitySecret: workspaceProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        propertySlug: z.enum([
          "sshKeyVaultRef",
          "npmTokenVaultRef",
          "githubTokenVaultRef",
        ]),
        secretValue: z.string().min(1),
        secretName: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const blob = encryptServerSide(input.secretValue);
      const name =
        input.secretName ?? `devplane_${input.propertySlug}_${input.entityId}`;

      const existing = await db.query.secrets.findFirst({
        where: and(eq(secrets.userId, ctx.userId), eq(secrets.name, name)),
        columns: { id: true },
      });

      let secretId: string;
      if (existing) {
        await db
          .update(secrets)
          .set({
            encryptedData: blob.encryptedData,
            iv: blob.iv,
            authTag: blob.authTag,
            updatedAt: new Date(),
          })
          .where(eq(secrets.id, existing.id));
        secretId = existing.id;
      } else {
        secretId = crypto.randomUUID();
        await db.insert(secrets).values({
          id: secretId,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          name,
          type: "api_key",
          encryptedData: blob.encryptedData,
          iv: blob.iv,
          authTag: blob.authTag,
          encryptionMode: "server",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      const vaultRef = `vault://${secretId}`;

      // Merge vault ref into entity properties JSONB
      await db
        .update(entities)
        .set({
          properties: drizzleSql`COALESCE(properties, '{}'::jsonb) || jsonb_build_object(${input.propertySlug}::text, ${vaultRef}::text)`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(entities.id, input.entityId), eq(entities.userId, ctx.userId))
        );

      logger.info(
        {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          entityId: input.entityId,
          propertySlug: input.propertySlug,
        },
        "Entity secret saved"
      );

      return { vaultRef };
    }),

  /**
   * Resolve a vault:// reference to its plaintext value (server-side only).
   *
   * Only resolves server-side encrypted secrets (`encryptionMode = "server"`).
   * Client-encrypted secrets are never returned — callers should not
   * assume a value is always available.
   */
  resolveEntitySecret: workspaceProcedure
    .input(z.object({ vaultRef: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const parsed = parseVaultReference(input.vaultRef);
      if (!parsed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invalid vault reference: ${input.vaultRef}`,
        });
      }

      // Agent/IS redemption path: enforce AI access grant semantics. An ACTIVE
      // vault_grants row must exist (granted via secretsVault.grantAIAccess) and
      // one use is consumed atomically. Internal/service paths (getServiceConfig,
      // getServiceSecret) do NOT pass requireGrant and remain ungated.
      let value: string | null;
      try {
        value = await resolveVaultSecret(
          parsed.secretId,
          ctx.userId,
          parsed.fieldName,
          { requireGrant: true }
        );
      } catch (err) {
        if (err instanceof VaultGrantError) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `Vault access denied: ${err.code}`,
            cause: err.code,
          });
        }
        throw err;
      }

      if (value === null) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Secret not found or not accessible",
        });
      }

      return { value };
    }),

  /**
   * Get which AI providers have API keys configured for the current user (without exposing keys).
   */
  getProviderConfigs: workspaceProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, ctx.workspaceId),
        columns: { settings: true },
      });

      const settings = (workspace?.settings ?? {}) as Record<string, unknown>;
      const devplane = (settings["devplane"] ?? {}) as Record<string, unknown>;
      // Per-user providers (each workspace member has independent keys)
      const userProviders = (devplane["userProviders"] ?? {}) as Record<
        string,
        Record<string, { apiKeyVaultRef?: string }>
      >;
      const myProviders = (userProviders[ctx.userId] ?? {}) as Record<
        string,
        { apiKeyVaultRef?: string }
      >;

      return {
        anthropic: {
          configured: isVaultReference(
            myProviders["anthropic"]?.apiKeyVaultRef ?? ""
          ),
        },
        openrouter: {
          configured: isVaultReference(
            myProviders["openrouter"]?.apiKeyVaultRef ?? ""
          ),
        },
        openai: {
          configured: isVaultReference(
            myProviders["openai"]?.apiKeyVaultRef ?? ""
          ),
        },
        aiTerminal: (devplane["aiTerminal"] ?? null) as {
          tool?: string;
          linkedProvider?: string;
          customCommand?: string;
        } | null,
      };
    }),
});
