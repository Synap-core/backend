/**
 * A `callProvider` body that carries this run's pod files as BYTES (plan
 * e7c3c98e phase 2b). A `:bytes` skill receives handles (`podfile:…`) in place
 * of file ids (`resolvePodFilesAtRun`); this turns the handles it puts in a
 * `callProvider` body into the host-side `fileBody` the dispatcher encodes and
 * streams from storage (`provider-file-body.ts`). The bytes never enter the
 * isolate.
 *
 * The skill writes the body it means, with handles where the files go:
 *   - JSON (default): a handle anywhere in the body becomes that slot's base64
 *     (`json-base64`; at most 20 MB of files per body);
 *     `callProvider("fal", "POST", "/edit", { image: args.photo })`.
 *   - `opts.multipart: true`: a `multipart/form-data` form. A handle, or a list
 *     of handles, under a key becomes file parts of that field; every other
 *     value is a text field (an object as JSON);
 *     `callProvider("unipile", "POST", "/posts", { account_id, text, attachments: args.media }, { multipart: true })`.
 *
 * Only THIS run's handles resolve: a `podfile:` string the run did not mint is
 * refused, never sent as text. Where the files may go (the verb's own tools)
 * is the dispatcher's check (`fileToolIds`).
 */
import type { ProviderFileBody } from "../../connectors/provider-file-body.js";
import {
  POD_FILE_HANDLE_PREFIX,
  type PodFileHandles,
} from "../capabilities/file-parameters.js";

export class PodFileBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodFileBodyError";
  }
}

const isHandle = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith(POD_FILE_HANDLE_PREFIX);

/**
 * The provider call's body, with this run's files resolved: `{ body }` when it
 * carries no handle (the call is unchanged), `{ fileBody }` when it does.
 */
export function podFileBodyFor(
  body: unknown,
  opts: { multipart?: unknown } | undefined,
  podFiles: PodFileHandles | undefined
): { body?: Record<string, unknown>; fileBody?: ProviderFileBody } {
  const json =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const fileOf = (handle: string) => {
    const file = podFiles?.files.get(handle);
    if (!file) {
      throw new PodFileBodyError(
        "callProvider: a podfile handle that is not a file of this run was given; only the handles this run received can be sent."
      );
    }
    return file;
  };

  if (opts?.multipart === true) {
    if (!json) {
      throw new PodFileBodyError(
        "callProvider: a multipart body must be an object of fields."
      );
    }
    const fields: Record<string, string> = {};
    const files: Array<{ field: string; file: ReturnType<typeof fileOf> }> = [];
    for (const [key, value] of Object.entries(json)) {
      const handles = isHandle(value)
        ? [value]
        : Array.isArray(value) && value.length > 0 && value.every(isHandle)
          ? (value as string[])
          : null;
      if (handles) {
        for (const h of handles) files.push({ field: key, file: fileOf(h) });
      } else if (value !== undefined && value !== null) {
        assertNoHandle(value);
        fields[key] = typeof value === "string" ? value : JSON.stringify(value);
      }
    }
    if (files.length === 0) {
      throw new PodFileBodyError(
        "callProvider: a multipart body needs at least one file of this run."
      );
    }
    return {
      fileBody: {
        encoding: "multipart",
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
        files,
      },
    };
  }

  if (!json) return {};
  const slots: Array<{
    path: Array<string | number>;
    file: ReturnType<typeof fileOf>;
  }> = [];
  const walk = (value: unknown, path: Array<string | number>) => {
    if (isHandle(value)) {
      slots.push({ path, file: fileOf(value) });
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...path, i]));
    } else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
    }
  };
  walk(json, []);
  if (slots.length === 0) return { body: json };
  return {
    fileBody: { encoding: "json-base64", json, files: slots },
  };
}

/** A handle nested inside a multipart TEXT field would be sent as text. */
function assertNoHandle(value: unknown): void {
  if (isHandle(value)) {
    throw new PodFileBodyError(
      "callProvider: a podfile handle can only be a multipart field's value (or a list of them), not nested in a text field."
    );
  }
  if (Array.isArray(value)) value.forEach(assertNoHandle);
  else if (typeof value === "object" && value !== null)
    Object.values(value).forEach(assertNoHandle);
}
