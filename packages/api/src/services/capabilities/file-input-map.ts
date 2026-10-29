/**
 * Pod files through an intent's ONE input (plan e7c3c98e phase 3).
 *
 * An intent's input may carry pod files: `publish_post.media` is a list of the
 * person's file ids. The input schema says so with an annotation on the field,
 * `"x-synap-pod-file": true` (`POD_FILE_INPUT_KEYWORD`), which the actions door
 * hands apps unchanged, so an app knows which field takes pod file ids.
 *
 * A verb's `inputMap` copies the field to one of its parameters. That
 * parameter must be a declared pod-file parameter (`file[]:url`,
 * `file[]:bytes`, `file-parameters.ts`): only then is each id read-checked as
 * the caller, named in the proposal, read again and sent after approval. A map
 * that copies pod file ids into a plain parameter would hand the tool bare ids
 * with none of that. And the other way: a pod-file parameter reads only a
 * pod-file field, never text, a URL, a constant, an account or a recipient.
 *
 * Checked where a map is installed (`createCapabilityFromDefinition`, official
 * definitions), beside `definitionInputMapProblems`. Pure.
 */
import { parseFileParameterType } from "./file-parameters.js";

/** The JSON Schema annotation marking an intent input field as pod file ids. */
export const POD_FILE_INPUT_KEYWORD = "x-synap-pod-file";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The intent input's pod-file fields: name → a list (`array`) or one id. */
export function podFileInputFields(
  intentSchema: Record<string, unknown> | null
): Map<string, { many: boolean }> {
  const out = new Map<string, { many: boolean }>();
  const properties = isRecord(intentSchema?.properties)
    ? intentSchema.properties
    : {};
  for (const [field, schema] of Object.entries(properties)) {
    if (isRecord(schema) && schema[POD_FILE_INPUT_KEYWORD] === true)
      out.set(field, { many: schema.type === "array" });
  }
  return out;
}

/**
 * Every problem with how a map moves pod files, one sentence each (empty =
 * installable). `inputMap` is the definition skill's raw map; its shape is
 * `definitionInputMapProblems`' to judge, so a map this cannot read is skipped.
 */
export function fileInputMapProblems(
  skill: { inputMap?: unknown; parameters?: unknown },
  intentSchema: Record<string, unknown> | null
): string[] {
  const params =
    isRecord(skill.inputMap) && isRecord(skill.inputMap.params)
      ? skill.inputMap.params
      : null;
  if (!params) return [];
  const podFields = podFileInputFields(intentSchema);
  const declared = isRecord(skill.parameters) ? skill.parameters : {};
  const problems: string[] = [];
  for (const [param, source] of Object.entries(params)) {
    const file = parseFileParameterType(declared[param]);
    const path = typeof source === "string" ? source : null;
    const field =
      path && /^\$\.[A-Za-z_][A-Za-z0-9_]*$/.test(path) ? path.slice(2) : null;
    const podField = field ? podFields.get(field) : undefined;

    if (podField && !file) {
      problems.push(
        `inputMap.params.${param}: "$.${field}" carries pod file ids; declare "${param}" as "file${podField.many ? "[]" : ""}:url" (or ":bytes") so each file is checked, named in the review and sent`
      );
    } else if (file && !podField) {
      problems.push(
        `inputMap.params.${param}: "${param}" is a pod-file parameter, so it can read only an input field of pod files${path ? `, and ${JSON.stringify(path)} is not one` : ", never a constant"}`
      );
    } else if (file && podField && file.many !== podField.many) {
      problems.push(
        `inputMap.params.${param}: "$.${field}" is ${podField.many ? "a list of files" : "one file"} but "${param}" takes ${file.many ? "a list" : "one file"}; declare it "file${podField.many ? "[]" : ""}:…"`
      );
    }
  }
  return problems;
}
