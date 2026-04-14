import { Chip, Input, Switch, Text, TextArea } from "@heroui/react";

import { colors, spacing, typography } from "../../theme/tokens";
import { trpc } from "../../lib/trpc";

const inputClass =
  "border-default-200 bg-background text-foreground focus:border-accent w-full rounded-lg border px-3 py-2 text-sm outline-none";

interface ToolFormGeneratorProps {
  toolName: string;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  errors?: Record<string, string>;
}

function FieldHeader({ name, required }: { name: string; required: boolean }) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1">
      <span
        className={`text-sm ${required ? "font-semibold" : "font-normal"}`}
        style={{ fontFamily: typography.fontFamily.sans }}
      >
        {name}
      </span>
      {required ? (
        <Chip size="sm" variant="soft" color="danger">
          Required
        </Chip>
      ) : null}
    </div>
  );
}

export default function ToolFormGenerator({
  toolName,
  value,
  onChange,
  errors,
}: ToolFormGeneratorProps) {
  const { data: toolSchema, isLoading } = trpc.system.getToolSchema.useQuery(
    { toolName },
    { enabled: !!toolName }
  );

  const handleFieldChange = (fieldName: string, fieldValue: unknown) => {
    onChange({
      ...value,
      [fieldName]: fieldValue,
    });
  };

  if (isLoading) {
    return (
      <Text className="text-sm" style={{ color: colors.text.tertiary }}>
        Loading tool schema...
      </Text>
    );
  }

  if (!toolSchema) {
    return (
      <Text className="text-sm" style={{ color: colors.text.tertiary }}>
        No schema available for this tool. Use JSON editor instead.
      </Text>
    );
  }

  const schemaProperties = toolSchema.schema?.properties || {};
  const requiredFields = toolSchema.schema?.required || [];
  const fields = Object.keys(schemaProperties).map((key) => {
    const prop = schemaProperties[key];
    const zodType = prop as {
      _def?: { innerType?: { typeName?: string }; typeName?: string };
      description?: string;
    };

    let fieldType = "string";
    if (zodType?._def) {
      const innerType = zodType._def.innerType || zodType._def;
      if (innerType?.typeName === "ZodString") {
        fieldType = "string";
      } else if (innerType?.typeName === "ZodNumber") {
        fieldType = "number";
      } else if (innerType?.typeName === "ZodBoolean") {
        fieldType = "boolean";
      } else if (innerType?.typeName === "ZodArray") {
        fieldType = "array";
      } else if (innerType?.typeName === "ZodEnum") {
        fieldType = "enum";
      }
    }

    return {
      name: key,
      type: fieldType,
      required: requiredFields.includes(key),
      description: zodType?.description,
    };
  });

  if (fields.length === 0) {
    return (
      <Text className="text-sm" style={{ color: colors.text.tertiary }}>
        No parameters defined for this tool. Use JSON editor instead.
      </Text>
    );
  }

  return (
    <div className="flex flex-col" style={{ gap: spacing[3] }}>
      {fields.map((field) => {
        const fieldValue = value[field.name];
        const fieldError = errors?.[field.name];

        switch (field.type) {
          case "string": {
            const isLongString =
              field.name.toLowerCase().includes("query") ||
              field.name.toLowerCase().includes("content") ||
              field.name.toLowerCase().includes("description");

            return isLongString ? (
              <div key={field.name}>
                <FieldHeader name={field.name} required={field.required} />
                <TextArea
                  className={inputClass}
                  placeholder={field.description || `Enter ${field.name}`}
                  value={(fieldValue as string) || ""}
                  onChange={(e) =>
                    handleFieldChange(field.name, e.target.value)
                  }
                  rows={4}
                />
                {fieldError ? (
                  <Text className="mt-1 text-xs text-danger">{fieldError}</Text>
                ) : null}
              </div>
            ) : (
              <div key={field.name}>
                <FieldHeader name={field.name} required={field.required} />
                <Input
                  className={inputClass}
                  placeholder={field.description || `Enter ${field.name}`}
                  value={(fieldValue as string) || ""}
                  onChange={(e) =>
                    handleFieldChange(field.name, e.target.value)
                  }
                />
                {fieldError ? (
                  <Text className="mt-1 text-xs text-danger">{fieldError}</Text>
                ) : null}
              </div>
            );
          }

          case "number":
            return (
              <div key={field.name}>
                <FieldHeader name={field.name} required={field.required} />
                <Input
                  type="number"
                  className={inputClass}
                  placeholder={field.description || `Enter ${field.name}`}
                  value={
                    fieldValue === undefined || fieldValue === null
                      ? ""
                      : String(fieldValue)
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    handleFieldChange(
                      field.name,
                      v === "" ? undefined : Number(v)
                    );
                  }}
                />
                {fieldError ? (
                  <Text className="mt-1 text-xs text-danger">{fieldError}</Text>
                ) : null}
              </div>
            );

          case "boolean":
            return (
              <div
                key={field.name}
                className="flex flex-col gap-1 rounded-lg border border-divider p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <FieldHeader name={field.name} required={field.required} />
                  <Switch
                    isSelected={Boolean(fieldValue)}
                    onChange={(selected) =>
                      handleFieldChange(field.name, selected)
                    }
                  >
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch>
                </div>
                {field.description ? (
                  <Text className="text-xs text-default-500">
                    {field.description}
                  </Text>
                ) : null}
                {fieldError ? (
                  <Text className="text-xs text-danger">{fieldError}</Text>
                ) : null}
              </div>
            );

          default:
            return (
              <div key={field.name}>
                <FieldHeader name={field.name} required={field.required} />
                <Input
                  className={inputClass}
                  placeholder={field.description || `Enter ${field.name}`}
                  value={String(fieldValue ?? "")}
                  onChange={(e) =>
                    handleFieldChange(field.name, e.target.value)
                  }
                />
                {fieldError ? (
                  <Text className="mt-1 text-xs text-danger">{fieldError}</Text>
                ) : null}
              </div>
            );
        }
      })}
    </div>
  );
}
