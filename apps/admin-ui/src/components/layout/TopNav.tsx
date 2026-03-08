import { Group, Text, Badge, ActionIcon, Tooltip, Menu } from "@mantine/core";
import {
  IconCommand,
  IconMenu2,
  IconUser,
  IconLogout,
} from "@tabler/icons-react";
import { useAuth } from "../../lib/auth";
import { useWorkspace } from "../../lib/workspace";
import { colors } from "../../theme/tokens";

interface TopNavProps {
  onMenuOpen?: () => void;
}

export default function TopNav({ onMenuOpen }: TopNavProps) {
  const { user, logout } = useAuth();
  const { workspaceName } = useWorkspace();

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
        {workspaceName && (
          <>
            <Text size="xs" c="dimmed" style={{ opacity: 0.5 }}>
              /
            </Text>
            <Text size="xs" style={{ color: colors.text.secondary }}>
              {workspaceName}
            </Text>
          </>
        )}
      </Group>

      {/* Actions */}
      <Group gap="xs">
        <Tooltip label="Command Menu (⌘K)" position="bottom">
          <ActionIcon
            variant="subtle"
            size="lg"
            color="gray"
            aria-label="Open command palette"
          >
            <IconCommand size={20} />
          </ActionIcon>
        </Tooltip>

        {/* User menu */}
        {user && (
          <Menu shadow="md" width={200} position="bottom-end">
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                size="lg"
                color="gray"
                aria-label="User menu"
              >
                <IconUser size={20} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{user.email}</Menu.Label>
              {user.name && (
                <Menu.Label style={{ fontWeight: 400, paddingTop: 0 }}>
                  {user.name}
                </Menu.Label>
              )}
              <Menu.Divider />
              <Menu.Item
                leftSection={<IconLogout size={14} />}
                color="red"
                onClick={logout}
              >
                Logout
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}

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
