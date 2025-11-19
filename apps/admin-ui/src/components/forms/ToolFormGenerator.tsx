import { useState } from 'react';
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

interface ToolFormGeneratorProps {
  toolName: string;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  errors?: Record<string, string>;
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
    return <Text size="sm" c={colors.text.tertiary}>Loading tool schema...</Text>;
  }

  if (!toolSchema) {
    return (
      <Text size="sm" c={colors.text.tertiary}>
        No schema available for this tool. Use JSON editor instead.
      </Text>
    );
  }

  // Extract fields from schema
  const schemaProperties = toolSchema.schema?.properties || {};
  const requiredFields = toolSchema.schema?.required || [];
  const fields = Object.keys(schemaProperties).map((key) => {
    const prop = schemaProperties[key];
    const zodType = prop as any;
    
    // Try to determine type from Zod schema
    let fieldType = 'string';
    if (zodType?._def) {
      const innerType = zodType._def.innerType || zodType._def;
      if (innerType?.typeName === 'ZodString') {
        fieldType = 'string';
      } else if (innerType?.typeName === 'ZodNumber') {
        fieldType = 'number';
      } else if (innerType?.typeName === 'ZodBoolean') {
        fieldType = 'boolean';
      } else if (innerType?.typeName === 'ZodArray') {
        fieldType = 'array';
      } else if (innerType?.typeName === 'ZodEnum') {
        fieldType = 'enum';
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
      <Text size="sm" c={colors.text.tertiary}>
        No parameters defined for this tool. Use JSON editor instead.
      </Text>
    );
  }

  return (
    <Stack gap={spacing[3]}>
      {fields.map((field) => {
        const fieldValue = value[field.name];
        const fieldError = errors?.[field.name];
        const hasError = !!fieldError;

        switch (field.type) {
          case 'string':
            const isLongString = field.name.toLowerCase().includes('query') ||
                                field.name.toLowerCase().includes('content') ||
                                field.name.toLowerCase().includes('description');
            
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

