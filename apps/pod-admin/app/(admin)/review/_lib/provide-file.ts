/**
 * Uploading a file to answer a `provide` ask, in Review — through the pod's
 * own upload door (`POST /api/files/upload`, the session cookie), into the
 * space the pod named for this session (`provideOptions` → `landing`), filed
 * into its project too. The new file's id is then the answer's reference.
 *
 * PURE apart from the injected `fetch`. The door decides (it re-checks the
 * write floor, the type and the size); the checks here only spare a round
 * trip and put its refusals in plain words. Whether the file is a type the
 * agent asked for is the shared rule (`provideFileAccepts`).
 */

import { provideFileAccepts } from "@synap-core/types/ask";
import type { FileLanding } from "./provide-options";

/** The buffered upload door's ceiling (`MAX_FILE_SIZE` on the pod). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Why the picked file can't go, before it is sent; null = it can. */
export function fileProblem(
  file: { name: string; type: string; size: number },
  accept: readonly string[] | null
): string | null {
  if (!provideFileAccepts(file, accept)) {
    return `The agent asked for ${accept!.join(", ")}. Pick a file of that type.`;
  }
  if (file.size === 0) return "This file is empty. Pick another one.";
  if (file.size > MAX_UPLOAD_BYTES) {
    return "This file is larger than 10 MB. Add larger files in the Synap app.";
  }
  return null;
}

/** The door's refusal, in words. */
export function uploadRefusalWords(status: number): string {
  switch (status) {
    case 401:
      return "Your sign-in has expired. Sign in again, then retry.";
    case 403:
      return "You can't add files to this space.";
    case 413:
      return "This file is too large to upload here. Add it in the Synap app.";
    case 415:
      return "This type of file can't be stored on the pod.";
    default:
      return "The upload didn't go through. Try again.";
  }
}

export type UploadResult =
  { ok: true; fileId: string } | { ok: false; status: number; message: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Send the file to the pod and return the new file's id — the reference the
 * answer carries. A network failure or an unreadable reply is a failed
 * upload, said in words.
 */
export async function uploadProvidedFile(p: {
  podUrl: string;
  file: File;
  landing: FileLanding;
  fetchImpl?: typeof fetch;
}): Promise<UploadResult> {
  const body = new FormData();
  body.append("file", p.file, p.file.name);
  body.append("workspaceId", p.landing.workspaceId);
  if (p.landing.projectId) body.append("projectId", p.landing.projectId);
  let res: Response;
  try {
    res = await (p.fetchImpl ?? fetch)(
      `${p.podUrl.replace(/\/$/, "")}/api/files/upload`,
      { method: "POST", body, credentials: "include" }
    );
  } catch {
    return { ok: false, status: 0, message: uploadRefusalWords(0) };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: uploadRefusalWords(res.status),
    };
  }
  const json: unknown = await res.json().catch(() => null);
  const id =
    json && typeof json === "object"
      ? (json as { entityId?: unknown }).entityId
      : undefined;
  return typeof id === "string" && UUID_RE.test(id)
    ? { ok: true, fileId: id }
    : { ok: false, status: res.status, message: uploadRefusalWords(0) };
}
