import { Button, Group, Stack, Text } from "@mantine/core";
import { IconTemplate } from "@tabler/icons-react";
import { colors, spacing, typography } from "../../theme/tokens";

interface EventTemplate {
  name: string;
  eventType: string;
  data: Record<string, unknown>;
  description?: string;
}

const EVENT_TEMPLATES: EventTemplate[] = [
  {
    name: "Note Creation",
    eventType: "note.creation.requested",
    description: "Create a new note",
    data: {
      content: "Your note content here",
      title: "Note Title",
      tags: ["tag1", "tag2"],
      autoEnrich: true,
      useRAG: false,
    },
  },
  {
    name: "Task Creation",
    eventType: "task.creation.requested",
    description: "Create a new task",
    data: {
      title: "Task Title",
      description: "Task description",
      dueDate: new Date().toISOString(),
      priority: "medium",
    },
  },
  {
    name: "Project Creation",
    eventType: "project.creation.requested",
    description: "Create a new project",
    data: {
      title: "Project Title",
      description: "Project description",
      startDate: new Date().toISOString(),
    },
  },
];

interface EventTemplatesProps {
  onSelectTemplate: (template: EventTemplate) => void;
}

export default function EventTemplates({
  onSelectTemplate,
}: EventTemplatesProps) {
  return (
    <Stack gap={spacing[2]}>
      <Group gap={spacing[2]}>
        <IconTemplate size={16} color={colors.text.secondary} />
        <Text
          size="sm"
          fw={typography.fontWeight.semibold}
          c={colors.text.primary}
        >
          Templates
        </Text>
      </Group>
      <Group gap={spacing[2]}>
        {EVENT_TEMPLATES.map((template) => (
          <Button
            key={template.name}
            variant="light"
            size="xs"
            onClick={() => onSelectTemplate(template)}
            title={template.description}
          >
            {template.name}
          </Button>
        ))}
      </Group>
    </Stack>
  );
}
