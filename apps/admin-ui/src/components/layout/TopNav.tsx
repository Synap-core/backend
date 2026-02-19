import {
  Group,
  Text,
  Badge,
  ActionIcon,
  Tooltip,
} from "@mantine/core";
import {
  IconCommand,
  IconMenu2,
} from "@tabler/icons-react";
import { colors } from "../../theme/tokens";

interface TopNavProps {
  onMenuOpen?: () => void;
}

export default function TopNav({ onMenuOpen }: TopNavProps) {
  return (
    <Group
      h={56}
      px="xl"
      justify="space-between"
      style={{
        borderBottom: `1px solid ${colors.border.default}`,
        background: colors.background.primary,
        position: "sticky",
        top: 0,
        zIndex: 100,
        flexShrink: 0,
      }}
    >
      {/* Logo */}
      <Group gap="sm">
        {/* Hamburger for mobile */}
        <ActionIcon
          variant="subtle"
          size="lg"
          color="gray"
          onClick={onMenuOpen}
          style={{ display: "none" }}
          className="mobile-menu-btn"
          aria-label="Open navigation"
        />
        <Text
          fw={700}
          size="lg"
          style={{
            background: `linear-gradient(135deg, ${colors.eventTypes.created} 0%, ${colors.eventTypes.ai} 100%)`,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          SYNAP
        </Text>
        <Badge size="xs" variant="light" color="gray">
          Admin
        </Badge>
      </Group>

      {/* Actions */}
      <Group gap="xs">
        <Tooltip label="Command Menu (⌘K)" position="bottom">
          <ActionIcon variant="subtle" size="lg" color="gray" aria-label="Open command palette">
            <IconCommand size={20} />
          </ActionIcon>
        </Tooltip>
        {onMenuOpen && (
          <Tooltip label="Navigation" position="bottom">
            <ActionIcon
              variant="subtle"
              size="lg"
              color="gray"
              onClick={onMenuOpen}
              aria-label="Toggle navigation"
            >
              <IconMenu2 size={20} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Group>
  );
}
