/**
 * Real dependencies for `createBackupKitRouter`: the kit files under the
 * pod's state dir (`backup-kit/kit-store.ts`), and the owner, Cloud-trust and
 * audit doors account recovery already uses.
 */

import { authMiddleware } from "@synap/auth";
import { refuseGuestSession } from "@synap/api";
import { createLogger } from "@synap-core/core";
import { readKitText, writeKitMarker } from "../backup-kit/kit-store.js";
import { podStateDir } from "../status/pod-data-status.js";
import {
  audit,
  findAccountByIdentity,
  isPodAdmin,
  readCloudTrust,
} from "./account-recovery-deps.js";
import type { BackupKitDeps } from "./backup-kit.js";

function publicHost(): string | null {
  try {
    return process.env.PUBLIC_URL
      ? new URL(process.env.PUBLIC_URL).hostname
      : null;
  } catch {
    return null;
  }
}

export const backupKitDeps: BackupKitDeps = {
  now: () => new Date(),
  logger: createLogger({ module: "backup-kit" }),
  authenticate: [authMiddleware, refuseGuestSession],
  findAccountByIdentity,
  isPodAdmin,
  readCloudTrust,
  kit: {
    readText: () => readKitText(podStateDir()),
    markSaved: () => writeKitMarker(podStateDir(), "saved"),
  },
  podHost: publicHost,
  audit,
};
