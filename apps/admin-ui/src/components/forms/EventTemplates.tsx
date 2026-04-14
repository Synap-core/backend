import { Button, Text } from "@heroui/react";
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
    <div className="flex flex-col gap-2" style={{ gap: spacing[2] }}>
      <div className="flex items-center gap-2">
        <IconTemplate size={16} color={colors.text.secondary} />
        <Text
          className="text-sm font-semibold"
          style={{
            fontWeight: typography.fontWeight.semibold,
            color: colors.text.primary,
          }}
        >
          Templates
        </Text>
      </div>
      <div className="flex flex-wrap gap-2">
        {EVENT_TEMPLATES.map((template) => (
          <span key={template.name} title={template.description ?? undefined}>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => onSelectTemplate(template)}
            >
              {template.name}
            </Button>
          </span>
        ))}
      </div>
    </div>
  );
}
