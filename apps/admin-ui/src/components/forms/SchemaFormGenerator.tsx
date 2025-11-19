import { useState, useEffect } from 'react';
import {
  TextInput,
  Textarea,
  NumberInput,
  Switch,
  Select,
  MultiSelect,
  Stack,
  Group,
  Button,
  ActionIcon,
  Text,
  Badge,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { colors, spacing, typography } from '../../theme/tokens';
import { trpc } from '../../lib/trpc';

interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  options?: string[];
  defaultValue?: unknown;
}

interface SchemaFormGeneratorProps {
  eventType: string;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  errors?: Record<string, string>;
}

export default function SchemaFormGenerator({
  eventType,
  value,
  onChange,
  errors,
}: SchemaFormGeneratorProps) {
  const { data: schemaData, isLoading } = trpc.system.getEventTypeSchema.useQuery(
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
    handleFieldChange(fieldName, [...currentArray, '']);
  };

  const handleArrayRemove = (fieldName: string, index: number) => {
    const currentArray = (value[fieldName] as unknown[]) || [];
    handleFieldChange(fieldName, currentArray.filter((_, i) => i !== index));
  };

  const handleArrayItemChange = (fieldName: string, index: number, itemValue: unknown) => {
    const currentArray = (value[fieldName] as unknown[]) || [];
    const newArray = [...currentArray];
    newArray[index] = itemValue;
    handleFieldChange(fieldName, newArray);
  };

  if (isLoading) {
    return <Text size="sm" c={colors.text.tertiary}>Loading form schema...</Text>;
  }

  if (!schemaData?.hasSchema || !schemaData.fields) {
    return (
      <Text size="sm" c={colors.text.tertiary}>
        No schema available for this event type. Use JSON editor instead.
      </Text>
    );
  }

  const fields = schemaData.fields;

  return (
    <Stack gap={spacing[3]}>
      {fields.map((field) => {
        const fieldValue = value[field.name] ?? field.defaultValue;
        const fieldError = errors?.[field.name];
        const hasError = !!fieldError;

        switch (field.type) {
          case 'string':
            // Use textarea for longer strings, text input for short ones
            const isLongString = field.name.toLowerCase().includes('content') ||
                                field.name.toLowerCase().includes('description') ||
                                field.name.toLowerCase().includes('body');
            
            return isLongString ? (
              <Textarea
                key={field.name}
                label={
                  <Group gap={spacing[1]}>
                    <Text size="sm" fw={field.required ? typography.fontWeight.semibold : typography.fontWeight.normal}>
                      {field.name}
                    </Text>
                    {field.required && <Badge size="xs" variant="light" color="red">Required</Badge>}
                  </Group>
                }
                placeholder={field.description || `Enter ${field.name}`}
                value={(fieldValue as string) || ''}
                onChange={(e) => handleFieldChange(field.name, e.currentTarget.value)}
                error={fieldError}
                required={field.required}
                minRows={4}
              />
            ) : (
              <TextInput
                key={field.name}
                label={
                  <Group gap={spacing[1]}>
                    <Text size="sm" fw={field.required ? typography.fontWeight.semibold : typography.fontWeight.normal}>
                      {field.name}
                    </Text>
                    {field.required && <Badge size="xs" variant="light" color="red">Required</Badge>}
                  </Group>
                }
                placeholder={field.description || `Enter ${field.name}`}
                value={(fieldValue as string) || ''}
                onChange={(e) => handleFieldChange(field.name, e.currentTarget.value)}
                error={fieldError}
                required={field.required}
              />
            );

          case 'number':
            return (
              <NumberInput
                key={field.name}
                label={
                  <Group gap={spacing[1]}>
                    <Text size="sm" fw={field.required ? typography.fontWeight.semibold : typography.fontWeight.normal}>
                      {field.name}
                    </Text>
                    {field.required && <Badge size="xs" variant="light" color="red">Required</Badge>}
                  </Group>
                }
                placeholder={field.description || `Enter ${field.name}`}
                value={(fieldValue as number) || undefined}
                onChange={(val) => handleFieldChange(field.name, val)}
                error={fieldError}
                required={field.required}
              />
            );

          case 'boolean':
            return (
              <Switch
                key={field.name}
                label={
                  <Group gap={spacing[1]}>
                    <Text size="sm" fw={field.required ? typography.fontWeight.semibold : typography.fontWeight.normal}>
                      {field.name}
                    </Text>
                    {field.required && <Badge size="xs" variant="light" color="red">Required</Badge>}
                  </Group>
                }
                description={field.description}
                checked={(fieldValue as boolean) || false}
                onChange={(e) => handleFieldChange(field.name, e.currentTarget.checked)}
                error={fieldError}
              />
            );

          case 'enum':
            return (
              <Select
                key={field.name}
                label={
                  <Group gap={spacing[1]}>
                    <Text size="sm" fw={field.required ? typography.fontWeight.semibold : typography.fontWeight.normal}>
                      {field.name}
                    </Text>
                    {field.required && <Badge size="xs" variant="light" color="red">Required</Badge>}
                  </Group>
                }
                placeholder={field.description || `Select ${field.name}`}
                data={field.options?.map(opt => ({ value: opt, label: opt })) || []}
                value={(fieldValue as string) || ''}
                onChange={(val) => handleFieldChange(field.name, val || '')}
                error={fieldError}
                required={field.required}
                clearable={!field.required}
              />
            );

          case 'array':
            const arrayValue = (fieldValue as unknown[]) || [];
            return (
              <div key={field.name}>
                <Group justify="space-between" mb={spacing[2]}>
                  <div>
                    <Text size="sm" fw={field.required ? typography.fontWeight.semibold : typography.fontWeight.normal}>
                      {field.name}
                    </Text>
                    {field.description && (
                      <Text size="xs" c={colors.text.tertiary} mt={2}>
                        {field.description}
                      </Text>
                    )}
                  </div>
                  {field.required && <Badge size="xs" variant="light" color="red">Required</Badge>}
                </Group>
                <Stack gap={spacing[2]}>
                  {arrayValue.map((item, index) => (
                    <Group key={index} gap={spacing[2]} align="flex-start">
                      <TextInput
                        style={{ flex: 1 }}
                        placeholder={`Item ${index + 1}`}
                        value={(item as string) || ''}
                        onChange={(e) => handleArrayItemChange(field.name, index, e.currentTarget.value)}
                        error={fieldError}
                      />
                      <ActionIcon
                        color="red"
                        variant="subtle"
                        onClick={() => handleArrayRemove(field.name, index)}
                        aria-label={`Remove item ${index + 1}`}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  ))}
                  <Button
                    variant="light"
                    size="xs"
                    leftSection={<IconPlus size={14} />}
                    onClick={() => handleArrayAdd(field.name)}
                  >
                    Add Item
                  </Button>
                </Stack>
                {fieldError && (
                  <Text size="xs" c="red" mt={4}>
                    {fieldError}
                  </Text>
                )}
              </div>
            );

          default:
            return (
              <TextInput
                key={field.name}
                label={
                  <Group gap={spacing[1]}>
                    <Text size="sm" fw={field.required ? typography.fontWeight.semibold : typography.fontWeight.normal}>
                      {field.name}
                    </Text>
                    {field.required && <Badge size="xs" variant="light" color="red">Required</Badge>}
                  </Group>
                }
                placeholder={field.description || `Enter ${field.name}`}
                value={String(fieldValue || '')}
                onChange={(e) => handleFieldChange(field.name, e.currentTarget.value)}
                error={fieldError}
                required={field.required}
              />
            );
        }
      })}
    </Stack>
  );
}

