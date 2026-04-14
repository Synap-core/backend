import { Button, Chip, Input, Switch, Text, TextArea } from "@heroui/react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { colors, spacing, typography } from "../../theme/tokens";
import { trpc } from "../../lib/trpc";

const inputClass =
  "border-default-200 bg-background text-foreground focus:border-accent w-full rounded-lg border px-3 py-2 text-sm outline-none";

interface SchemaFormGeneratorProps {
  eventType: string;
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

export default function SchemaFormGenerator({
  eventType,
  value,
  onChange,
  errors,
}: SchemaFormGeneratorProps) {
  const { data: schemaData, isLoading } =
    trpc.system.getEventTypeSchema.useQuery(
      { eventType },
      { enabled: !!eventType }
    );

  const handleFieldChange = (fieldName: string, fieldValue: unknown) => {
    onChange({
      ...value,
      [fieldName]: fieldValue,
    });
  };

  const handleArrayAdd = (fieldName: string) => {
    const currentArray = (value[fieldName] as unknown[]) || [];
    handleFieldChange(fieldName, [...currentArray, ""]);
  };

  const handleArrayRemove = (fieldName: string, index: number) => {
    const currentArray = (value[fieldName] as unknown[]) || [];
    handleFieldChange(
      fieldName,
      currentArray.filter((_, i) => i !== index)
    );
  };

  const handleArrayItemChange = (
    fieldName: string,
    index: number,
    itemValue: unknown
  ) => {
    const currentArray = (value[fieldName] as unknown[]) || [];
    const newArray = [...currentArray];
    newArray[index] = itemValue;
    handleFieldChange(fieldName, newArray);
  };

  if (isLoading) {
    return (
      <Text className="text-sm" style={{ color: colors.text.tertiary }}>
        Loading form schema...
      </Text>
    );
  }

  if (!schemaData?.hasSchema || !schemaData.fields) {
    return (
      <Text className="text-sm" style={{ color: colors.text.tertiary }}>
        No schema available for this event type. Use JSON editor instead.
      </Text>
    );
  }

  const fields = schemaData.fields;

  return (
    <div className="flex flex-col" style={{ gap: spacing[3] }}>
      {fields.map((field) => {
        const fieldValue = value[field.name] ?? field.defaultValue;
        const fieldError = errors?.[field.name];

        switch (field.type) {
          case "string": {
            const isLongString =
              field.name.toLowerCase().includes("content") ||
              field.name.toLowerCase().includes("description") ||
              field.name.toLowerCase().includes("body");

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

          case "enum": {
            const opts = field.options ?? [];
            return (
              <div key={field.name}>
                <FieldHeader name={field.name} required={field.required} />
                <select
                  className={inputClass}
                  value={(fieldValue as string) || ""}
                  onChange={(e) =>
                    handleFieldChange(field.name, e.target.value)
                  }
                  required={field.required}
                >
                  {!field.required ? (
                    <option value="">
                      — {field.description || "Select"} —
                    </option>
                  ) : null}
                  {opts.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
                {fieldError ? (
                  <Text className="mt-1 text-xs text-danger">{fieldError}</Text>
                ) : null}
              </div>
            );
          }

          case "array": {
            const arrayValue = (fieldValue as unknown[]) || [];
            return (
              <div key={field.name}>
                <div
                  className="mb-2 flex justify-between gap-2"
                  style={{ marginBottom: spacing[2] }}
                >
                  <div>
                    <span
                      className={`text-sm ${field.required ? "font-semibold" : "font-normal"}`}
                      style={{ fontFamily: typography.fontFamily.sans }}
                    >
                      {field.name}
                    </span>
                    {field.description ? (
                      <Text
                        className="mt-0.5 text-xs"
                        style={{ color: colors.text.tertiary }}
                      >
                        {field.description}
                      </Text>
                    ) : null}
                  </div>
                  {field.required ? (
                    <Chip size="sm" variant="soft" color="danger">
                      Required
                    </Chip>
                  ) : null}
                </div>
                <div className="flex flex-col" style={{ gap: spacing[2] }}>
                  {arrayValue.map((item, index) => (
                    <div
                      key={index}
                      className="flex items-start gap-2"
                      style={{ gap: spacing[2] }}
                    >
                      <Input
                        className={`${inputClass} min-w-0 flex-1`}
                        placeholder={`Item ${index + 1}`}
                        value={(item as string) || ""}
                        onChange={(e) =>
                          handleArrayItemChange(
                            field.name,
                            index,
                            e.target.value
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        aria-label={`Remove item ${index + 1}`}
                        onPress={() => handleArrayRemove(field.name, index)}
                      >
                        <IconTrash size={16} />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onPress={() => handleArrayAdd(field.name)}
                  >
                    <span className="inline-flex items-center gap-1">
                      <IconPlus size={14} />
                      Add Item
                    </span>
                  </Button>
                </div>
                {fieldError ? (
                  <Text className="mt-1 text-xs text-danger">{fieldError}</Text>
                ) : null}
              </div>
            );
          }

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
