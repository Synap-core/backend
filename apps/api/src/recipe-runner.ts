/**
 * Recipe Runner WebSocket
 *
 * Runs an ordered list of shell commands via SSH on a remote server, streaming
 * per-step output back to the browser in real time.
 *
 * WebSocket URL:
 *   ws://host:4000/api/devplane/recipe-run?recipeId=<entityId>&envId=<entityId>&ticket=<wsTicket>
 *
 * Messages TO browser (JSON strings):
 *   { type: "connected" }                                          — handshake complete
 *   { type: "step_start", index: N, name: "...", command: "..." } — step beginning
 *   { type: "output",     index: N, data: "..." }                 — stdout/stderr chunk
 *   { type: "step_done",  index: N, exitCode: N, success: bool }  — step finished
 *   { type: "recipe_done", success: bool, duration: ms }          — all steps complete
 *   { type: "error", message: "..." }                             — fatal error
 *
 * Messages FROM browser (JSON):
 *   { type: "cancel" }   — abort after the current step finishes
 */

import { Client as SshClient, type ClientChannel } from "ssh2";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { db, eq, and } from "@synap/database";
import { entities } from "@synap/database/schema";
import { parseVaultReference, resolveVaultSecret } from "@synap/api";
import { resolveUserId } from "./ws-auth.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "recipe-runner" });

// Lazy-initialised — no HTTP server attached; we handle upgrade manually.
let wss: WebSocketServer | null = null;

function getWss(): WebSocketServer {
  if (!wss) {
    wss = new WebSocketServer({ noServer: true });
  }
  return wss;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface RecipeStep {
  name: string;
  command: string;
  continueOnError?: boolean;
}

interface StepResult {
  name: string;
  command: string;
  status: "success" | "failed" | "skipped";
  exitCode: number;
  output: string;
  startedAt: string;
  finishedAt: string;
}

interface SshSessionConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Load a devplane_environment entity and resolve SSH credentials via Vault.
 * Mirrors resolveEnvironmentCredentials in ssh-proxy.ts.
 */
async function resolveEnvironmentCredentials(
  environmentEntityId: string,
  userId: string
): Promise<SshSessionConfig> {
  const entity = await db.query.entities.findFirst({
    where: and(
      eq(entities.id, environmentEntityId),
      eq(entities.userId, userId)
    ),
    columns: { id: true, type: true, properties: true },
  });

  if (!entity) {
    throw new Error(
      `Environment entity not found or access denied: ${environmentEntityId}`
    );
  }

  if (entity.type !== "devplane_environment") {
    throw new Error(
      `Entity ${environmentEntityId} is not a devplane_environment (got: ${entity.type})`
    );
  }

  const props = (entity.properties ?? {}) as Record<string, unknown>;

  const host = props["envHost"] as string | undefined;
  const username = props["sshUser"] as string | undefined;
  const sshKeyVaultRef = props["sshKeyVaultRef"] as string | undefined;
  const port =
    typeof props["envPort"] === "number" ? (props["envPort"] as number) : 22;

  if (!host) throw new Error("Environment entity missing envHost property");
  if (!username) throw new Error("Environment entity missing sshUser property");
  if (!sshKeyVaultRef)
    throw new Error("Environment entity missing sshKeyVaultRef property");

  const ref = parseVaultReference(sshKeyVaultRef);
  if (!ref) {
    throw new Error(`Invalid vault reference: ${sshKeyVaultRef}`);
  }

  const privateKey = await resolveVaultSecret(
    ref.secretId,
    userId,
    ref.fieldName
  );
  if (!privateKey) {
    throw new Error(
      "Could not resolve SSH private key from vault — ensure the secret exists and uses server-side encryption"
    );
  }

  return { host, port, username, privateKey };
}

// ─── Step executor ────────────────────────────────────────────────────────────

async function runStep(
  ssh: SshClient,
  ws: WebSocket,
  step: RecipeStep,
  index: number
): Promise<{ exitCode: number; success: boolean; output: string }> {
  return new Promise((resolve) => {
    sendJson(ws, {
      type: "step_start",
      index,
      name: step.name,
      command: step.command,
    });

    ssh.exec(step.command, (err: Error | undefined, stream: ClientChannel) => {
      if (err) {
        sendJson(ws, { type: "step_done", index, exitCode: 1, success: false });
        resolve({ exitCode: 1, success: false, output: err.message });
        return;
      }

      let outputBuffer = "";

      const sendChunk = (data: Buffer): void => {
        const chunk = data.toString("utf8");
        outputBuffer += chunk;
        sendJson(ws, { type: "output", index, data: chunk });
      };

      stream.on("data", sendChunk);
      stream.stderr.on("data", sendChunk);

      stream.on("close", (code: number | null) => {
        const exitCode = code ?? 0;
        const success = exitCode === 0;
        sendJson(ws, { type: "step_done", index, exitCode, success });
        resolve({ exitCode, success, output: outputBuffer });
      });
    });
  });
}

// ─── Recipe executor ──────────────────────────────────────────────────────────

async function runRecipe(
  ws: WebSocket,
  recipeEntityId: string,
  envEntityId: string,
  userId: string
): Promise<void> {
  let sshClient: SshClient | null = null;
  const startedAt = new Date();
  let cancelled = false;

  // Listen for cancel messages from the browser
  ws.on("message", (data: Buffer | string) => {
    try {
      const msg = JSON.parse(
        typeof data === "string" ? data : data.toString("utf8")
      ) as Record<string, unknown>;
      if (msg.type === "cancel") {
        cancelled = true;
        logger.info({ recipeEntityId }, "Recipe run cancelled by client");
      }
    } catch {
      // ignore non-JSON
    }
  });

  try {
    // 1. Fetch recipe entity
    const recipeEntity = await db.query.entities.findFirst({
      where: and(eq(entities.id, recipeEntityId), eq(entities.userId, userId)),
      columns: {
        id: true,
        type: true,
        title: true,
        workspaceId: true,
        properties: true,
      },
    });

    if (!recipeEntity) {
      sendJson(ws, {
        type: "error",
        message: `Recipe entity not found or access denied: ${recipeEntityId}`,
      });
      ws.close(1008, "Recipe not found");
      return;
    }

    if (recipeEntity.type !== "devplane_recipe") {
      sendJson(ws, {
        type: "error",
        message: `Entity ${recipeEntityId} is not a devplane_recipe (got: ${recipeEntity.type})`,
      });
      ws.close(1008, "Wrong entity type");
      return;
    }

    const recipeProps = (recipeEntity.properties ?? {}) as Record<
      string,
      unknown
    >;
    const recipeName =
      (recipeProps["recipeName"] as string | undefined) ??
      recipeEntity.title ??
      "Unnamed Recipe";
    const onFailure =
      (recipeProps["onFailure"] as
        | "stop"
        | "continue"
        | "rollback"
        | undefined) ?? "stop";

    let steps: RecipeStep[] = [];
    const rawSteps = recipeProps["recipeSteps"] as string | undefined;
    if (rawSteps) {
      try {
        steps = JSON.parse(rawSteps) as RecipeStep[];
      } catch {
        sendJson(ws, {
          type: "error",
          message: "Invalid recipeSteps JSON — could not parse steps array",
        });
        ws.close(1008, "Invalid steps");
        return;
      }
    }

    if (steps.length === 0) {
      sendJson(ws, {
        type: "error",
        message: "Recipe has no steps to run",
      });
      ws.close(1008, "No steps");
      return;
    }

    // 2. Resolve SSH credentials for the environment
    const creds = await resolveEnvironmentCredentials(envEntityId, userId);

    // 3. Connect SSH
    sshClient = new SshClient();

    await new Promise<void>((resolve, reject) => {
      sshClient!.on("ready", () => resolve());
      sshClient!.on("error", (err: Error) => reject(err));
      sshClient!.connect({
        host: creds.host,
        port: creds.port,
        username: creds.username,
        privateKey: creds.privateKey,
        readyTimeout: 20_000,
      });
    });

    logger.info(
      {
        recipeEntityId,
        envId: envEntityId,
        host: creds.host,
        stepCount: steps.length,
      },
      "Recipe SSH connection established, starting steps"
    );

    // 4. Send connected message
    sendJson(ws, { type: "connected" });

    // 5. Run steps sequentially
    const stepResults: StepResult[] = [];
    let overallSuccess = true;

    for (let i = 0; i < steps.length; i++) {
      if (cancelled) {
        logger.info(
          { recipeEntityId, stepIndex: i },
          "Aborting recipe — cancelled"
        );
        break;
      }

      const step = steps[i]!;
      const stepStartedAt = new Date().toISOString();

      const result = await runStep(sshClient, ws, step, i);

      const stepResult: StepResult = {
        name: step.name,
        command: step.command,
        status: result.success ? "success" : "failed",
        exitCode: result.exitCode,
        output: result.output,
        startedAt: stepStartedAt,
        finishedAt: new Date().toISOString(),
      };
      stepResults.push(stepResult);

      if (!result.success) {
        overallSuccess = false;
        if (onFailure === "stop" && !step.continueOnError) {
          logger.info(
            { recipeEntityId, stepIndex: i, exitCode: result.exitCode },
            "Step failed — stopping recipe (onFailure=stop)"
          );
          break;
        }
        // onFailure === "continue" or step.continueOnError → keep going
      }
    }

    const duration = Date.now() - startedAt.getTime();

    // 6. Send recipe_done
    sendJson(ws, { type: "recipe_done", success: overallSuccess, duration });

    // 7. Persist the recipe run entity
    try {
      await db.insert(entities).values({
        id: crypto.randomUUID(),
        userId,
        workspaceId: recipeEntity.workspaceId,
        profileId: null,
        type: "devplane_recipe_run",
        title: `Run: ${recipeName} — ${startedAt.toISOString()}`,
        properties: {
          recipeId: recipeEntityId,
          runStatus: cancelled
            ? "cancelled"
            : overallSuccess
              ? "success"
              : "failed",
          runSteps: JSON.stringify(stepResults),
          runStartedAt: startedAt.toISOString(),
          runFinishedAt: new Date().toISOString(),
          runDuration: duration,
          triggeredBy: "manual",
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (persistErr: unknown) {
      const msg =
        persistErr instanceof Error ? persistErr.message : String(persistErr);
      logger.error(
        { err: msg, recipeEntityId },
        "Failed to persist recipe run entity (non-fatal)"
      );
    }

    ws.close(1000, "Recipe complete");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Recipe run failed";
    logger.error({ err: message, recipeEntityId }, "Recipe run error");
    try {
      sendJson(ws, { type: "error", message });
      ws.close(1011, message);
    } catch {
      // ignore
    }
  } finally {
    sshClient?.end();
  }
}

// ─── Upgrade handler ──────────────────────────────────────────────────────────

/**
 * Handle HTTP upgrade requests for the recipe runner WebSocket endpoint.
 *
 * Only handles `GET /api/devplane/recipe-run` — caller (ws-router.ts) routes
 * here after path matching, so unknown paths are never received.
 */
export function handleRecipeRunUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const url = new URL(req.url ?? "", "http://localhost");

  const recipeId = url.searchParams.get("recipeId");
  const envId = url.searchParams.get("envId");

  if (!recipeId) {
    socket.write(
      "HTTP/1.1 400 Bad Request\r\nContent-Length: 18\r\n\r\nMissing recipeId"
    );
    socket.destroy();
    return;
  }

  if (!envId) {
    socket.write(
      "HTTP/1.1 400 Bad Request\r\nContent-Length: 14\r\n\r\nMissing envId"
    );
    socket.destroy();
    return;
  }

  resolveUserId(req)
    .then((userId) => {
      if (!userId) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\n\r\nUnauthorized"
        );
        socket.destroy();
        return;
      }

      getWss().handleUpgrade(req, socket, head, (ws: WebSocket) => {
        logger.info(
          { recipeId, envId, userId },
          "Recipe run WebSocket upgrade accepted"
        );
        runRecipe(ws, recipeId, envId, userId);
      });
    })
    .catch((err) => {
      logger.error({ err }, "Recipe runner upgrade auth error");
      socket.destroy();
    });
}
