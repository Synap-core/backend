/**
 * Background starters: everything the backend starts besides answering HTTP,
 * each declaring the process roles it runs in (pod resilience plan P6).
 *
 * SYNAP_PROCESS_ROLE (`@synap/events` process-role.ts) picks the role; the
 * boot (index.ts) serves the HTTP app for `all`/`api` or the /health-only app
 * for `worker` (./worker-health.ts), then runs `startBackground(role, phase)`
 * for its two phases. Nothing else in index.ts may start background work: the
 * tripwire `__tripwires__/background-starters-declare-role.tripwire.test.ts`
 * derives every starter-shaped call in index.ts from source and refuses one
 * outside this table, so a new starter has to say where it runs.
 *
 * `runsIn` names each role explicitly, `all` included, so `all` is exactly
 * what one process ran before the split (the role switch test pins it) and a
 * starter that must run in ONE process of a split pod (a cron clock, a boot
 * one-shot, a writer under no lock) cannot run in both by accident.
 *
 * The roles of a split pod, and why:
 *   api    — the request side: HTTP/MCP, the startup hooks (they load the
 *            in-memory CORS origins and the readiness the API reports), the
 *            LISTENs whose consumers are its sockets and SSE streams, a
 *            pg-boss that only sends, and the boot backfills that wait on the
 *            startup hooks (marker-stamped, capped per boot).
 *   worker — every pg-boss worker, the cron clock and maintenance, the boot
 *            one-shots that notify (update outcome, heal notices).
 *   both   — the event-loop watch (each process measures its own), the side
 *            -effect reactors (an event is appended in both processes, and
 *            `emitSideEffects` runs its reactors where it is called), the jobs
 *            IoC slots (filled functions start nothing; a slot read by code in
 *            either process is filled in both), the skill runner warm-up
 *            (capabilities run from requests and from jobs).
 *
 * Code is moved here from index.ts unchanged, except: each block is a
 * function, `apiLogger` is `ctx.log`, and the pg-boss block of `all` is split
 * at its seams (workers, slots, one-shots, crons, backfills), in its order.
 * Every module is imported inside its starter, so this table loads cheaply
 * in a test.
 */

import type { ProcessRole } from "@synap/jobs";

export type BootPhase = "boot" | "listening";

export interface StarterLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface StarterContext {
  role: ProcessRole;
  localMode: boolean;
  log: StarterLog;
  /** Set by the pg-boss starter of this role once pg-boss is running. */
  boss: { started: boolean };
}

export interface BackgroundStarter {
  key: string;
  /** The roles this starter runs in: at least one, `all` named explicitly. */
  runsIn: readonly [ProcessRole, ...ProcessRole[]];
  /**
   * `boot`: right after `serve()` returns (where index.ts started its
   * module-level background work). `listening`: in serve()'s listen callback.
   */
  phase: BootPhase;
  /** Kicked off and not awaited: the next starter does not wait for it. */
  detached?: boolean;
  /** One line: why it runs where it runs. */
  why: string;
  start(ctx: StarterContext): void | Promise<void>;
}

const ALL_ROLES = ["all", "api", "worker"] as const;
const API_SIDE = ["all", "api"] as const;
const WORKER_SIDE = ["all", "worker"] as const;

export const BACKGROUND_STARTERS: readonly BackgroundStarter[] = [
  // ── boot phase ─────────────────────────────────────────────────────────────
  {
    key: "event-loop-watch",
    runsIn: ALL_ROLES,
    phase: "boot",
    why: "each process measures its own event loop (/health eventLoop)",
    // The event-loop watch: a stall logs the requests that ran across it
    // (status/event-loop-watch.ts). Its timer is unref'd.
    async start() {
      const { eventLoopWatch } = await import("../status/event-loop-watch.js");
      const { registerEventLoopP99Reader } = await import("@synap/api");
      eventLoopWatch.start();
      // Pod health (plan P3 G10) reads the same event-loop delay /health
      // serves. Each process registers its own: on a split pod the pod-health
      // job runs in the worker and reads the WORKER's loop; the API's loop is
      // read by heal's /health probe.
      registerEventLoopP99Reader(() => {
        const delay = eventLoopWatch.snapshot().delay;
        return delay.state === "measured" ? delay.p99Ms : null;
      });
    },
  },
  {
    key: "kratos-cors-probe",
    runsIn: API_SIDE,
    phase: "boot",
    detached: true,
    why: "a log-only probe of the config the API's sign-in depends on",
    // Kratos config coherence tripwire — non-fatal.
    //
    // Mirrors the schema check above but for `kratos.yml` drift. The most common
    // failure mode is: `.env`'s DOMAIN changed (CP-driven `configure-pod.sh`,
    // manual edit) but kratos.yml was never regenerated, so the running kratos
    // serves a stale `allowed_origins` list. Browsers calling pod-admin then see
    // CORS rejections that look like "no Access-Control-Allow-Origin header" —
    // hard to diagnose because the network 200/4xx pretends to be a CORS bug.
    //
    // We probe Kratos directly with a CORS preflight from the expected
    // pod-admin origin. If the running kratos echoes the Origin back in
    // Access-Control-Allow-Origin, its config is in sync; otherwise we log
    // loudly and emit a structured event the dashboard can surface.
    //
    // NOT fatal — drift here doesn't take down the API, and we don't want a
    // transient kratos restart to block backend boot. The operator's fix is:
    // `./synap start kratos` (which now regenerates kratos.yml).
    async start({ log }) {
      const { configuredPodAdminBase } = await import("../pod-admin-config.js");
      const domain = process.env.DOMAIN?.trim();
      if (!domain || domain === "localhost") return; // dev mode — skip

      const admin = configuredPodAdminBase();
      if (!admin.ok) {
        log.warn(
          { code: admin.code },
          "Kratos CORS coherence check skipped — Pod Admin URL is not configured"
        );
        return;
      }
      const expectedOrigin = admin.base.origin;
      const kratosPublicUrl =
        process.env.KRATOS_PUBLIC_URL?.replace(/\/$/, "") ||
        "http://kratos:4433";

      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const probeUrl = `${kratosPublicUrl}/self-service/login/api`;
        const res = await fetch(probeUrl, {
          method: "OPTIONS",
          headers: {
            Origin: expectedOrigin,
            "Access-Control-Request-Method": "GET",
          },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const acao = res.headers.get("access-control-allow-origin") ?? "";
        if (acao !== expectedOrigin && acao !== "*") {
          log.warn(
            { expectedOrigin, kratosAcao: acao || "<missing>", probeUrl },
            "Kratos CORS coherence check FAILED — pod-admin will see CORS errors. " +
              "Run `./synap start kratos` on the pod host to regenerate kratos.yml."
          );
        } else {
          log.info({ expectedOrigin }, "Kratos CORS coherence check passed");
        }
      } catch (err) {
        // Don't block boot on a probe failure — kratos may be starting up
        // alongside us and we shouldn't gate the API on it.
        log.debug(
          { err: err instanceof Error ? err.message : String(err) },
          "Kratos CORS coherence probe could not reach kratos (will retry on next boot)"
        );
      }
    },
  },
  {
    key: "control-plane-issuer-probe",
    runsIn: API_SIDE,
    phase: "boot",
    detached: true,
    why: "a log-only probe of the issuer the API's federated sign-in verifies",
    // Control Plane federation-issuer coherence tripwire — non-fatal.
    //
    // Mirrors the Kratos CORS check above, for a different drift class. The CP signs
    // federation assertions with `getControlPlaneIssuerUrl()` (its CP_ISSUER_URL /
    // api.${APP_DOMAIN} identity), which is DELIBERATELY independent from the pod's
    // CONTROL_PLANE_URL transport value. `seedControlPlaneIssuer` now discovers the
    // declared issuer via /federation/metadata so the seed self-corrects, but this
    // probe surfaces the divergence LOUDLY at boot so an operator can see it — the
    // symptom otherwise is silent 401s on every federated assertion the pod verifies.
    //
    // Read-only diagnostics: it fetches the CP's declared issuer and compares it to
    // the transport-derived origin. It does NOT mutate the trusted-issuer registry.
    // Skipped when CONTROL_PLANE_URL is unset (self-hosted without a CP).
    async start({ log }) {
      const { controlPlaneBaseUrl } =
        await import("@synap-core/core/control-plane-url");
      const { normalizeIssuerUrl, fetchFederationMetadata } =
        await import("@synap/api");
      const controlPlaneUrl = controlPlaneBaseUrl();
      if (!controlPlaneUrl) return; // self-hosted without a CP — nothing to probe

      const transportIssuer = normalizeIssuerUrl(controlPlaneUrl);
      try {
        const metadata = await fetchFederationMetadata(controlPlaneUrl);
        if (transportIssuer && metadata.issuer !== transportIssuer) {
          log.warn(
            {
              declaredIssuer: metadata.issuer,
              transportIssuer,
              controlPlaneUrl,
            },
            "Control Plane federation-issuer coherence: DRIFT — the CP signs with a " +
              "different issuer than CONTROL_PLANE_URL implies. Federated sign-in " +
              "relies on the DISCOVERED issuer (seeded from /federation/metadata); " +
              "verify the CP's CP_ISSUER_URL if this is unexpected."
          );
        } else {
          log.info(
            { issuer: metadata.issuer },
            "Control Plane federation-issuer coherence check passed"
          );
        }
      } catch (err) {
        // Don't block boot on a probe failure — the CP may be unreachable or too
        // old to serve /federation/metadata; the seed already fell back gracefully.
        log.debug(
          {
            err: err instanceof Error ? err.message : String(err),
            controlPlaneUrl,
          },
          "Control Plane federation-issuer coherence probe could not fetch metadata (non-fatal)"
        );
      }
    },
  },
  {
    key: "startup-hooks",
    runsIn: API_SIDE,
    phase: "boot",
    detached: true,
    why: "they load the in-memory CORS origins and the readiness /health reports",
    // Run startup hooks after server is listening.
    async start({ log }) {
      const { runStartupHooks } = await import("../startup-hooks.js");
      await runStartupHooks().catch((err) => {
        log.error({ err }, "Startup hooks failed (non-fatal)");
      });
    },
  },
  {
    key: "skill-runtime-warm",
    runsIn: ALL_ROLES,
    phase: "boot",
    detached: true,
    why: "code skills run from requests (MCP) and from jobs (automations)",
    // Code skills run on this pod (default since R2): start one runner process now, so
    // /health's `skillRuntime` answers at boot whether it can. Never throws.
    async start() {
      const { warmSkillRuntime } = await import("@synap/api");
      void warmSkillRuntime();
    },
  },
  {
    key: "document-title-backfill",
    runsIn: API_SIDE,
    phase: "boot",
    detached: true,
    why: "waits on the startup hooks, which run on the API side; once per version",
    async start({ log }) {
      const { startupHooksSettled } = await import("../startup-hooks.js");
      // One-title BACKFILL (founder 2026-10-19): documents written before the create
      // door applied the one-title rule lose a leading heading equal to their name,
      // ONCE, as a new revision each (rollback-able). Rides the boot pass beside the
      // media backfills, but outside the pg-boss block so local-mode pods run it too.
      // Stamped on pod_settings (versioned); a later boot is a no-op. Off the boot path.
      await startupHooksSettled
        .then(async () => {
          const { backfillDocumentTitleHeadings } = await import("@synap/api");
          const r = await backfillDocumentTitleHeadings();
          if (r.status !== "already-complete")
            log.info(r, "Document title backfill ran");
        })
        .catch((err) =>
          log.warn(
            { err },
            "Document title backfill failed (non-fatal; resumes next boot)"
          )
        );
    },
  },
  {
    key: "retire-unasked-decision-asks",
    runsIn: API_SIDE,
    phase: "boot",
    detached: true,
    why: "waits on the startup hooks, which run on the API side; once (marker)",
    async start({ log }) {
      const { startupHooksSettled } = await import("../startup-hooks.js");
      // Decision asks NOBODY ASKED: open asks the old reactor raised on a person's
      // own proposed decision retire `not_asked`, and the Decide sessions it opened
      // for them close through the one close door. Runs ONCE (a pod_settings
      // marker, written only after a pass with no failure); later boots return at
      // the marker. Off the boot path.
      await startupHooksSettled
        .then(async () => {
          const { retireUnaskedDecisionAsks } = await import("@synap/api");
          await retireUnaskedDecisionAsks();
        })
        .catch((err) =>
          log.warn(
            { err },
            "Retiring unasked decision asks failed (non-fatal; resumes next boot)"
          )
        );
    },
  },
  {
    key: "session-changed-listener",
    runsIn: API_SIDE,
    phase: "boot",
    detached: true,
    why: "its consumers are the API's long-polls; the DB trigger sees every writer",
    async start({ log }) {
      const { startSessionChangedListener } = await import("@synap/api");
      // Live session updates: the ONE producer of `focus_session:updated` — LISTENs
      // on the migration-0277 row trigger, so every session writer pushes. Never
      // throws; polling is the floor if the LISTEN is down.
      startSessionChangedListener().catch((err) => {
        log.error(
          { err },
          "Session changed listener failed to start (non-fatal)"
        );
      });
    },
  },
  {
    key: "event-stream-relay-listener",
    runsIn: ["api"],
    phase: "boot",
    detached: true,
    why: "a split API holds the hub SSE streams; the worker's events reach them by NOTIFY",
    // utils/event-stream-relay.ts. A one-process pod broadcasts locally and
    // has no relay to listen to.
    async start({ log }) {
      const { startEventStreamRelayListener } = await import("@synap/api");
      startEventStreamRelayListener().catch((err) => {
        log.error(
          { err },
          "Event stream relay listener failed to start (non-fatal)"
        );
      });
    },
  },

  // ── listening phase (serve()'s callback) ───────────────────────────────────
  {
    key: "side-effect-reactors",
    runsIn: ALL_ROLES,
    phase: "listening",
    why: "emitSideEffects runs its reactors in the process that appends the event",
    async start() {
      const api = await import("@synap/api");
      // IoC: fill the pod-wide proposal notification seam. `emitSideEffects`
      // runs its reactors in THIS process, which is also the process that runs
      // every pg-boss worker — so registering here is what lets a proposal filed
      // by the @synap/jobs widen-lane scanner reach the pod owner + admins
      // without jobs importing @synap/api. Registered before the boss branch:
      // the registry is process-global, and `emitSideEffects` already no-ops
      // when pg-boss is unavailable (LOCAL_MODE).
      api.registerPodWideProposalReactor();
      // Same seam for session dependencies: the close door emits
      // `focus_session.closed`, this reactor derives whether the last open
      // blocker just went away and files ONE `session.unblocked` notification.
      api.registerSessionUnblockReactor();
      // Same seam, entity writes: a `proposed` decision opens ONE owed ask
      // slot for the person; a decision resolved elsewhere retires it.
      api.registerDecisionAskReactor();
      // "Choose an agent" answered ⇒ the run that owed it is re-dispatched
      // through the same executor path, idempotently.
      api.registerAgentChoiceRedispatchReactor();
      // Same close event again: a session that ENDED with required criteria
      // still unmet is news the founder is told once, on the phone — it is the
      // one moment a course correction is cheap. Re-derives the verdict from
      // `session_evaluations` rather than trusting the event's payload.
      api.registerSessionCriteriaUnmetReactor();
      // Same two events (a run closed, a goal moved or its loop switched on):
      // the goal proposes its next run while a required criterion is unmet.
      api.registerGoalLoopReactor();
      // Same close event: the session document gains its structured closing
      // report (outcome, definition of done, outputs, decisions).
      api.registerClosingReportReactor();
      // Any content save (a person's autosave, a restore, an approval): re-check
      // which embeds will not render, stamped with the revision it checked.
      api.registerDocumentDiagnosticsReactor();
      // Any entity create/update (applied, never proposed): copy the external
      // images it names into the pod — off the request path.
      api.registerEntityMediaCopyReactor();
    },
  },
  {
    key: "local-sync-driver",
    runsIn: WORKER_SIDE,
    phase: "listening",
    why: "LOCAL_MODE's scheduler (no pg-boss); LOCAL_MODE runs only as `all`",
    async start({ localMode, log }) {
      if (!localMode) return;
      // Local mode: pg-boss is disabled (untested on PGlite and would
      // double-fire sync workers alongside the local sync driver).
      // The local sync driver handles all scheduling instead.
      log.info(
        "Local mode: pg-boss disabled; local sync driver handles scheduling"
      );
      const { startLocalSyncDriver } = await import("@synap/jobs");
      startLocalSyncDriver();
      log.info("Local sync driver started (LOCAL_MODE)");
    },
  },
  {
    key: "pg-boss-send",
    runsIn: ["api"],
    phase: "listening",
    why: "a split API enqueues jobs but works none: no supervision, no cron clock",
    // boss.ts builds this role's pg-boss with supervise:false, schedule:false.
    // The queues are created here too: pg-boss v10 refuses a send to a queue
    // that does not exist, and the worker may boot after the API.
    async start(ctx) {
      if (ctx.localMode) return;
      try {
        const { startBoss, createAllQueues } = await import("@synap/jobs");
        await startBoss();
        await createAllQueues();
        ctx.boss.started = true;
        ctx.log.info("pg-boss started to send only (SYNAP_PROCESS_ROLE=api)");
      } catch (err) {
        ctx.log.error(
          { err },
          "Failed to start pg-boss (non-fatal, side-effects will be unavailable)"
        );
      }
    },
  },
  {
    key: "pg-boss-workers",
    runsIn: WORKER_SIDE,
    phase: "listening",
    why: "the job workers, pg-boss maintenance and its cron clock run in one process",
    async start(ctx) {
      if (ctx.localMode) return;
      // Start pg-boss job queue
      try {
        const { startBoss, registerAllWorkers } = await import("@synap/jobs");
        await startBoss();
        await registerAllWorkers();
        ctx.boss.started = true;
      } catch (err) {
        ctx.log.error(
          { err },
          "Failed to start pg-boss (non-fatal, side-effects will be unavailable)"
        );
      }
    },
  },
  {
    key: "jobs-ioc-slots",
    runsIn: ALL_ROLES,
    phase: "listening",
    why: "filled functions start nothing; jobs code read in either process finds its slot",
    async start({ localMode, log }) {
      if (localMode) return;
      // IoC: fill the import-corpus handler slot owned by @synap/jobs with
      // the orchestrator binding. jobs owns the queue + worker; api (which
      // alone may import the orchestrator) fills the slot here at boot —
      // respecting the one-way api → jobs dependency. analyzeLarge produces
      // a governed import.graph PROPOSAL (never a direct write); from
      // trpcCtx it reads only the acting agent, to attribute that proposal.
      {
        const { registerImportCorpusHandler } =
          await import("@synap/jobs/workers/import-corpus-worker.js");
        const { ImportOrchestrator } = await import("@synap/api");
        registerImportCorpusHandler(async (p) => {
          // `p.sessionId` — the run room ensured before enqueue. Absent on a
          // job queued before the field existed: analyzeLarge then resolves
          // (mints) a session itself, as it always did.
          const res = await new ImportOrchestrator({
            workspaceId: p.workspaceId,
            userId: p.userId,
            // Only the acting agent rides: analyzeLarge reads it to
            // attribute the proposal it files (null for a human caller).
            trpcCtx: { agentUserId: p.agentUserId ?? null },
            sessionId: p.sessionId ?? null,
          }).analyzeLarge({
            source: p.source as never,
            items: p.items,
            sessionId: p.sessionId ?? null,
            // The caller's opt-in, carried by the job (deterministic when absent).
            ...(p.aiStructure === true ? { aiStructure: true } : {}),
          });
          // Project the orchestrator's own numbers into the queue's OUTPUT
          // contract (ImportCorpusResult). pg-boss persists whatever the
          // worker resolves to as the job `output`, which is what
          // GET /import/corpus-job/:jobId reads — before this, the result
          // was discarded and a run that dropped 2 of 3 files still polled
          // as a clean "completed". Only a PROJECTION travels: the full
          // return carries every operation of the graph, which belongs on
          // the proposal, not in the job row. No count is recomputed here.
          return {
            proposalId: res.proposalId ?? null,
            workspaceId: res.workspaceId ?? null,
            ...(typeof res.quality?.counts?.filesProcessed === "number"
              ? { filesProcessed: res.quality.counts.filesProcessed }
              : {}),
            ...(typeof res.quality?.counts?.filesFailed === "number"
              ? { filesFailed: res.quality.counts.filesFailed }
              : {}),
            ...(typeof res.quality?.score === "number"
              ? { qualityScore: res.quality.score }
              : {}),
            findings: (res.quality?.findings ?? [])
              .filter((f) => f.severity === "warn" || f.severity === "blocker")
              .slice(0, 8)
              .map((f) => ({
                id: f.id,
                severity: f.severity,
                message: f.message,
              })),
          };
        });
        log.info("Registered import-corpus handler (IoC)");
      }

      // IoC: the store-first bulk import (`POST /import/enqueue-units`). jobs
      // owns the `import-units` queue; the unit door (the governed create,
      // then the attach gate) lives in api, so the handler is filled here.
      {
        const { registerImportUnitsHandler } =
          await import("@synap/jobs/workers/import-units-worker.js");
        const { runImportUnitsJob } = await import("@synap/api");
        registerImportUnitsHandler((p) => runImportUnitsJob(p));
        log.info("Registered import-units handler (IoC)");
      }

      // IoC: a LARGE approval, applied in the background. jobs owns the
      // `proposal-approve` queue; the approval door lives in api, so the
      // handler is filled here. Every gate already ran in the approve
      // request (services/proposals/approval-runs.ts).
      {
        const { registerProposalApproveHandler } =
          await import("@synap/jobs/workers/proposal-approve-worker.js");
        const { runApprovalJob } = await import("@synap/api");
        registerProposalApproveHandler((p) => runApprovalJob(p));
        log.info("Registered proposal-approve handler (IoC)");
      }

      // IoC: the Library light read (one item) and its hourly sweep. jobs
      // owns both queues; the readers, the IS client and the AI budget live
      // in api, so the handlers are filled here.
      {
        const {
          registerLibraryLightReadHandler,
          registerLibraryLightReadSweepHandler,
        } = await import("@synap/jobs/workers/library-light-read-worker.js");
        const { runLibraryLightReadJob, sweepLibraryLightReads } =
          await import("@synap/api");
        registerLibraryLightReadHandler((p) => runLibraryLightReadJob(p));
        registerLibraryLightReadSweepHandler(() => sweepLibraryLightReads());
        log.info("Registered library light-read handlers (IoC)");
      }

      // IoC: after each official catalog sync (10 min), converge the
      // installed capabilities whose template a publish changed — the
      // boot reconcile's door, narrowed. Deferred drift surfaces
      // as the same grouped bell item.
      {
        const { registerOfficialCatalogSyncedHandler } =
          await import("@synap/jobs/workers/cp-catalog-sync.js");
        const {
          reconcileChangedCapabilityTemplates,
          notifyCapabilityUpdatesAvailable,
          installOfficialAgentTemplates,
        } = await import("@synap/api");
        registerOfficialCatalogSyncedHandler(async () => {
          // The catalog installs every official agent template on every pod
          // (founder decision D8). First, and it never throws, so a failed
          // capability converge below cannot skip it.
          await installOfficialAgentTemplates();
          const report = await reconcileChangedCapabilityTemplates();
          if (report) await notifyCapabilityUpdatesAvailable(report);
        });
        log.info("Registered catalog-synced reconcile handler (IoC)");
      }

      // IoC: the Library keep-alive pass (daily). jobs owns the queue and
      // its cron; the pass writes notifications through NotificationService,
      // which lives in api, so the handler is filled here.
      {
        const { registerLibraryKeepAliveHandler } =
          await import("@synap/jobs/workers/library-keep-alive-worker.js");
        const { runLibraryKeepAlive } = await import("@synap/api");
        registerLibraryKeepAliveHandler(async () => {
          const { archived, suggested, resurfaced } =
            await runLibraryKeepAlive();
          return { archived, suggested, resurfaced };
        });
        log.info("Registered library keep-alive handler (IoC)");
      }

      // IoC: the morning brief pass (every 15 min). jobs owns the queue
      // and its cron; the pass reads the needs-you rule and writes through
      // NotificationService, both in api, so the handler is filled here.
      {
        const { registerMorningBriefHandler } =
          await import("@synap/jobs/workers/morning-brief-worker.js");
        const { runMorningBriefs } = await import("@synap/api");
        registerMorningBriefHandler(() => runMorningBriefs());
        log.info("Registered morning brief handler (IoC)");
      }

      // IoC: the pod health check (every 2 min, plan P3 G10). jobs owns
      // the queue and its cron; the check reads pod settings and writes
      // through NotificationService, both in api.
      {
        const { registerPodHealthHandler } =
          await import("@synap/jobs/workers/pod-health-worker.js");
        const { runPodHealthCheck } = await import("@synap/api");
        registerPodHealthHandler(() => runPodHealthCheck());
        log.info("Registered pod health handler (IoC)");
      }

      // IoC: fill the capability / signal / feed-runner slots owned by
      // @synap/jobs with the @synap/api implementations. The pg-boss workers
      // run IN this process, but @synap/jobs can't statically import
      // @synap/api (circular dep) — so we inject here at boot. This replaces
      // the former /internal/* HTTP loopback + BRIDGE_SECRET: everything is a
      // direct in-process call now.
      {
        const {
          registerCapabilityExecutor,
          registerPlaybookRunner,
          registerPlaybookReadinessGate,
          registerSessionScheduler,
        } = await import("@synap/jobs/workers/automation-executor.js");
        const { registerAgentWaker } =
          await import("@synap/jobs/utils/agent-wake.js");
        const { registerMailFeedRunner } =
          await import("@synap/jobs/workers/mail-feed-cron.js");
        const { registerCalBackfillRunner } =
          await import("@synap/jobs/workers/cal-backfill-cron.js");
        const {
          registerFirefliesIngestRunner,
          registerFirefliesBackfillRunner,
        } = await import("@synap/jobs/workers/fireflies-worker.js");
        const {
          registerMessagingHistoryImportRunner,
          registerMessagingWebhookEnsureRunner,
          registerLinkedinReachSweepRunner,
        } = await import("@synap/jobs/workers/messaging-sync.js");
        const { registerSessionRecallRunner } =
          await import("@synap/jobs/workers/session-recall-worker.js");
        const { registerGoalLoopSweeper, registerSessionLifecycleSweeper } =
          await import("@synap/jobs/workers/focus-session-reaper.js");
        const { registerInboundAttachmentIngestRunner } =
          await import("@synap/jobs/workers/inbound-attachment-worker.js");
        const { registerEntityMediaCopyRunner } =
          await import("@synap/jobs/workers/entity-media-copy-worker.js");
        const { registerDevLoopRunner } =
          await import("@synap/jobs/workers/dev-loop-worker.js");
        const { registerObservationDoor } =
          await import("@synap/jobs/utils/observation-door.js");
        const { registerEventSyncRunner } =
          await import("@synap/jobs/workers/event-sync-cron.js");
        const { registerConnectionSyncRunner } =
          await import("@synap/jobs/workers/connection-sync-run.js");
        const { registerStaleProposalRunner } =
          await import("@synap/jobs/workers/stale-proposal-cron.js");
        const { registerBrokenAutomationRunner } =
          await import("@synap/jobs/workers/broken-automation-cron.js");
        const { registerCleanupPackRunner } =
          await import("@synap/jobs/workers/pod-hygiene-cleanup-pack-cron.js");
        const { registerNotificationCreator } =
          await import("@synap/jobs/utils/notification-creator.js");
        const { registerEventEndRunner } =
          await import("@synap/jobs/workers/event-end-cron.js");
        const { registerKeyGrantAudience } =
          await import("@synap/jobs/workers/webhook-worker.js");
        const { registerExternalAgentPoller } =
          await import("@synap/jobs/workers/external-agent-poll.js");
        const { registerTightenRecommender } =
          await import("@synap/jobs/workers/governance-tighten-cron.js");
        const { registerPromptVersionRegressionScanner } =
          await import("@synap/jobs/workers/prompt-quality-cron.js");
        const { registerSessionRecapRunner } =
          await import("@synap/jobs/workers/session-recap.js");
        const { registerSignalRouter } =
          await import("@synap/jobs/utils/proactive-post.js");
        const { registerSessionCloser, registerStoppedSessionStaler } =
          await import("@synap/jobs/utils/session-close.js");
        const { registerHoldResumeFollowUp } =
          await import("@synap/jobs/workers/hold-resume.js");
        const { registerStatusWatcherRunner } =
          await import("@synap/jobs/workers/status-watcher-cron.js");
        const { registerStageAdvancer } =
          await import("@synap/jobs/utils/stage-advance.js");
        const { registerSessionOutcomeDoor } =
          await import("@synap/jobs/utils/session-outcome-door.js");
        const { registerServiceHealthNotifier } =
          await import("@synap/jobs/workers/intelligence-health-check.js");
        const api = await import("@synap/api");
        registerCapabilityExecutor((input) => api.executeCapability(input));
        // ONE playbook-run spine: the scheduled path (@synap/jobs) delegates
        // to api's runPlaybook via this slot, so is-agent | external-agent |
        // hybrid all dispatch through the executor spine + triggerAutoRespond.
        registerPlaybookRunner((input) => api.runPlaybook(input));
        // ONE unattended readiness rule: a propose-mode rule checks the
        // playbook's skills with the spine's own preflight before it files
        // a run proposal (an unrunnable one is the enable request instead).
        registerPlaybookReadinessGate((input) =>
          api.checkUnattendedPlaybookReadiness(input)
        );
        // ONE appointment materializer: a `playbook_run` node whose mode is
        // "appointment" creates a `status:'scheduled'` focus_session that
        // WAITS for the human — it never reaches the runner above, so no
        // agent is dispatched at a session the person was meant to open.
        // This slot is the pod's ONLY producer of `FocusSessionStatus.SCHEDULED`.
        registerSessionScheduler((input) =>
          api.materializeScheduledSession(input)
        );
        // ONE session-close door: the reapers and the automation executor
        // used to stamp `status:'closed'` with a raw UPDATE, skipping the
        // review pack, the session-bound ephemeral expiry and both halves
        // of the close event (@synap-core/types/focus-sessions states the
        // invariant outright). They now call completeFocusSession through
        // this slot. Every close through it is automatic: the system's.
        registerSessionCloser((input) =>
          api.completeFocusSession({
            ...input,
            actor: { kind: "system", userId: input.userId },
          })
        );
        // ONE stopped-session door (decision E1): the hourly reaper stales
        // a session no agent moved for 7 days whose only owed items are
        // its agent's confirm / choose asks, and those asks end with it.
        registerStoppedSessionStaler((input) => api.staleStoppedSession(input));
        // A hold's resume (W4) owes what the api's doors do after the same
        // move: a goal's judgement notices, a stale session's runs.
        registerHoldResumeFollowUp((resumed) =>
          api.holdResumeFollowUp(resumed)
        );
        // The status watcher (W6): late, approaching, stuck and
        // hold-review signals, raised once per episode, owner told.
        registerStatusWatcherRunner(() => api.runStatusWatcher());
        // ONE stage-advance door: the automation `session_update` output
        // wrote `focus_sessions.current_stage` with a raw UPDATE and resolved
        // no stage gate, so an automation could advance a run straight past a
        // `gate: { kind: "human" }` approval. The slot is FAIL-CLOSED —
        // unregistered it throws rather than advancing ungated — so this
        // registration is what makes the automation stage-advance work at all.
        registerStageAdvancer((input) => api.advanceSessionStage(input));
        // ONE set of session outcome doors (plan v5 T2): an automation's
        // GRANTED complete_outcome / post_evidence / reevaluate_criterion
        // reaches the same api functions the approval executor applies.
        // Fail-closed: unregistered, the step throws.
        registerSessionOutcomeDoor(api.sessionOutcomeDoor);
        // ONE agent-wake spine: an automation's `channel_message` with
        // `wakeAgent: true` reaches `triggerAutoRespond` — the SAME door
        // every IS auto-respond uses (`a2ai-one-door` tripwire forbids a
        // second enqueue) — through this slot, because @synap/jobs cannot
        // import @synap/api. Unfilled, the slot refuses the wake BEFORE the
        // message is posted, so this registration is what makes the feature
        // reachable at all.
        registerAgentWaker((req) => api.triggerAutoRespond(req));
        registerMailFeedRunner(() => api.runMailFeed());
        registerCalBackfillRunner(() => api.runCalBackfill());
        // Fireflies: webhook-triggered ingest + the backfill safety net both
        // delegate to api-side runners (executeCapability + recordInboundMessage).
        registerFirefliesIngestRunner((input) => api.runFirefliesIngest(input));
        registerFirefliesBackfillRunner(() => api.runFirefliesBackfill());
        // Messaging: the silent history import and the webhook
        // self-registration (messaging-sync.ts) run api-side code.
        registerMessagingHistoryImportRunner((input) =>
          api.runMessagingHistoryImport(input)
        );
        registerMessagingWebhookEnsureRunner(() =>
          api.runMessagingWebhookEnsure()
        );
        registerLinkedinReachSweepRunner(() => api.runLinkedinReachSweep());
        // Session recall (on start / the sweep floor) delegates to the
        // api-side runner — requested by session synap-68.
        registerSessionRecallRunner((d) => api.runSessionRecall(d));
        // The goal loop's hourly re-check (W4) rides the focus-session
        // reaper's tick: no scheduler of its own.
        registerGoalLoopSweeper(() => api.sweepGoalLoops());
        // The session lifecycle (C6) rides the same tick: met work closes,
        // work waiting on a merge is held, a week-stale unowed agent
        // session is cancelled, an ended run closes — and the stale sweeps
        // leave runs to their run (the kind's RUN predicate).
        registerSessionLifecycleSweeper({
          sweep: () => api.sweepSessionLifecycle(),
          runSessionWhere: () => api.runSessionWhere(),
        });
        // Inbound attachments: fetch bytes off the sensor path → GOVERNED
        // file door → link to channel + message (IoC across the api↔jobs dep).
        registerInboundAttachmentIngestRunner((input) =>
          api.runInboundAttachmentIngest(input)
        );
        // Entity media copy: the reactor enqueues after an entity write;
        // the api-side runner fetches + stores + records systemData.media.
        registerEntityMediaCopyRunner((input) => api.runEntityMediaCopy(input));
        // Dev loop (plan v5 T2): the observation door enqueues a fact the
        // pod acts on (`dev.pr_merged`); the api-side runner moves the
        // sessions it is about (the merge sweeper).
        registerDevLoopRunner((input) => api.runDevLoopObservation(input));
        // ONE observation writer: an automation's `record_observation`
        // step records an outside fact (a GitHub webhook read into
        // `dev.pr_merged`) through the observation door's own checks.
        // Fail-closed: unregistered, the step throws.
        registerObservationDoor((input) =>
          api.recordObservationFromAutomation(input)
        );
        // The Discord mirror pass. Google Calendar events reach it as Synap
        // `event` entities landed by the connection sync — never straight
        // to Discord.
        registerEventSyncRunner(() => api.runEventSync());
        // ONE connection sync door: a triggered job (connect / CP webhook
        // poke) names its provider + connection; the scheduled tick names
        // none and walks every sync-enabled connection.
        registerConnectionSyncRunner((data) =>
          data.provider
            ? api.runConnectionSync({
                provider: data.provider,
                connectionId: data.connectionId,
                workspaceId: data.workspaceId,
                reason: data.reason,
              })
            : api.runScheduledConnectionSyncs(data.reason ?? "cron")
        );
        registerEventEndRunner(() => api.runEventEnd());
        // D7: a key-bound webhook's domain events are delivered only when
        // the key's grant reads the subject — the API's access layer.
        // Unfilled, the fan-out sends key-bound subscriptions nothing.
        registerKeyGrantAudience((s) => api.keyGrantReadsSubject(s));
        registerExternalAgentPoller(() => api.pollExternalAgentRuns());
        // Learning loop: the tighten recommender (was verb-only) and the
        // prompt-version regression scan run on daily crons. Both slots
        // are fail-closed — unregistered, the job throws.
        registerTightenRecommender(() => api.recommendTightenForAllAgents());
        registerPromptVersionRegressionScanner(() =>
          api.notifyPromptVersionRegressions()
        );
        // ONE cron, two reasons to walk the pending table. `scanStale`
        // detects a workspace that disappeared; `expireLapsed` detects time
        // passing. Separate detections, deliberately sharing the 6h tick
        // rather than adding a second cron over the same rows.
        registerStaleProposalRunner(async () => {
          // Settled independently: a throw in one detection must not
          // silently switch the other off until someone reads the log.
          const [stale, lapsed] = await Promise.allSettled([
            api.scanStaleProposals(),
            api.expireLapsedProposals(),
          ]);
          for (const [name, r] of [
            ["scanStaleProposals", stale],
            ["expireLapsedProposals", lapsed],
          ] as const) {
            if (r.status === "rejected")
              log.error(
                { err: r.reason },
                `${name} failed on the stale-proposal tick`
              );
          }
          return { stale, lapsed };
        });
        registerBrokenAutomationRunner(() => api.scanBrokenAutomations());
        registerCleanupPackRunner(() => api.fileCleanupPacks());
        // The ONE notification write door, reached from jobs. Until this
        // call, three jobs producers inserted into `notifications` directly,
        // so preferences never applied to them and they never pushed — and
        // because `agent.task_failed` and `ai.proactive.insight` ALSO have
        // compliant producers in packages/api, those two types were
        // PARTIALLY governed: a mute silenced some emissions and not
        // others, which reads as flakiness rather than as a bug.
        registerNotificationCreator((input) =>
          api.NotificationService.create(input)
        );
        registerSessionRecapRunner((input) => api.runSessionRecap(input));
        registerSignalRouter((input) => api.routeSignal(input));
        // The 2-minute IS health cron used to only log a degraded verdict.
        // It now nudges the operator through the SAME connector-health door
        // (in-app + Discord notice, 6h dedup) across the api↔jobs dep.
        registerServiceHealthNotifier((input) =>
          api.notifyIntelligenceServiceUnhealthy(input)
        );
        log.info(
          "Registered capability / mail-feed / event-sync / event-end / session-recap / signal handlers (IoC)"
        );
      }
    },
  },
  {
    key: "boot-one-shots",
    runsIn: WORKER_SIDE,
    phase: "listening",
    why: "once per boot of the background side: a split pod must not notify twice",
    async start({ boss, log }) {
      if (!boss.started) return;
      const { getBoss } = await import("@synap/jobs");
      const { MESSAGING_WEBHOOK_ENSURE_QUEUE } =
        await import("@synap/jobs/workers/messaging-sync.js");
      const { readLastUpdate } = await import("../pod-updates/index.js");
      const { startHealNoticeWatch } = await import("../status/heal-events.js");
      const api = await import("@synap/api");
      // Deferred and non-fatal: check the webhook a minute after boot
      // rather than waiting for the hourly cron.
      try {
        await getBoss().send(
          MESSAGING_WEBHOOK_ENSURE_QUEUE,
          {},
          { startAfter: 60 }
        );
      } catch (err) {
        log.warn(
          { err },
          "messaging-webhook-ensure boot check not queued (non-fatal)"
        );
      }
      // U4: a rollback recreates the backend, so this boot is when the
      // owner learns an update did not land. Once per update id per
      // admin (idempotent on the notification rows); a failed or absent
      // read notifies nobody — it is logged, never guessed.
      void readLastUpdate()
        .then((r) => {
          if (r.read === "failed") {
            log.warn(
              { error: r.error },
              "Could not read the last update outcome"
            );
            return;
          }
          if (r.read === "ok") {
            // A failure tells the owner; a success is a fact the pod
            // records (`dev.deployed`) so automations can follow it.
            return Promise.all([
              api.notifyPodUpdateOutcome(r.outcome),
              api.recordPodDeployed(r.outcome),
            ]).then(() => undefined);
          }
          return undefined; // read === "absent": no update recorded yet
        })
        .catch((err) =>
          log.warn({ err }, "Update outcome notification failed")
        );
      // G7b: the host's self-heal (`synap heal`) records each restart,
      // and why, in deploy/state/events.jsonl. Read now (a heal restart
      // of this backend is what led to this boot) and every 5 min (a
      // restart of another service, a spent budget); the owner and
      // admins are told once (`pod-heal-notice.ts`). The timer is
      // unref'd and the process exits on SIGTERM, so it needs no stop.
      startHealNoticeWatch({
        notify: (events) => api.notifyPodHealEvents(events),
        warn: (obj, msg) => log.warn(obj, msg),
      });
    },
  },
  {
    key: "cron-schedules",
    runsIn: WORKER_SIDE,
    phase: "listening",
    why: "the cron rows are written where the cron clock (pg-boss schedule) runs",
    async start({ boss, log }) {
      if (!boss.started) return;
      const { registerCronSchedules } = await import("@synap/jobs");
      await registerCronSchedules();
      log.info("pg-boss job queue started with all workers registered");
    },
  },
  {
    key: "media-backfills",
    runsIn: API_SIDE,
    phase: "listening",
    why: "they wait on the startup hooks (API side) and enqueue through pg-boss",
    async start({ boss, log }) {
      if (!boss.started) return;
      const { startupHooksSettled } = await import("../startup-hooks.js");
      // Media-copy BACKFILL: entities written before the reactor
      // existed never got a pod copy of their images. Once the startup
      // reconciles have stamped every kind's presentation, enqueue the
      // SAME per-entity copy job for each one that owes media — spread
      // out, resumable, stamped on pod_settings so a later boot is a
      // no-op until the media scope changes. Off the boot path.
      void startupHooksSettled
        .then(async () => {
          const { backfillEntityMediaCopies } = await import("@synap/api");
          const r = await backfillEntityMediaCopies();
          if (r.status === "completed")
            log.info(r, "Media-copy backfill enqueued");
        })
        .catch((err) =>
          log.warn(
            { err },
            "Media-copy backfill failed (non-fatal; resumes next boot)"
          )
        );

      // Library thumbnail BACKFILL: items read before the Library copied
      // media hold no pod copy, and clients draw a thumbnail only from one.
      // Their card image goes through the SAME copy door, one at a time,
      // rate-limited and capped per boot (resumes next boot); an expired
      // link is recorded on the item as a failed copy. Off the boot path.
      void startupHooksSettled
        .then(async () => {
          const { backfillLibraryItemMedia } = await import("@synap/api");
          const r = await backfillLibraryItemMedia();
          if (r.status !== "already-complete")
            log.info(r, "Library media backfill ran");
        })
        .catch((err) =>
          log.warn(
            { err },
            "Library media backfill failed (non-fatal; resumes next boot)"
          )
        );
    },
  },
];

/** The starters a role runs in one phase, in table order. */
export function startersFor(
  role: ProcessRole,
  phase: BootPhase,
  starters: readonly BackgroundStarter[] = BACKGROUND_STARTERS
): BackgroundStarter[] {
  return starters.filter(
    (s) => s.phase === phase && (s.runsIn as readonly string[]).includes(role)
  );
}

/**
 * Run a role's starters for one phase, in table order: a detached starter is
 * kicked off, any other is awaited. A failure is logged and never stops the
 * boot, as each of these was non-fatal in index.ts.
 */
export async function startBackground(
  ctx: StarterContext,
  phase: BootPhase,
  starters: readonly BackgroundStarter[] = BACKGROUND_STARTERS
): Promise<string[]> {
  const started: string[] = [];
  for (const s of startersFor(ctx.role, phase, starters)) {
    started.push(s.key);
    const fail = (err: unknown) =>
      ctx.log.error(
        { err, starter: s.key },
        "Background starter failed (non-fatal)"
      );
    if (s.detached) {
      void Promise.resolve()
        .then(() => s.start(ctx))
        .catch(fail);
      continue;
    }
    try {
      await s.start(ctx);
    } catch (err) {
      fail(err);
    }
  }
  return started;
}
