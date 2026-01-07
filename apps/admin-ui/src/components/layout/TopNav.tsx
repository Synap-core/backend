import { Group, Text, Badge, ActionIcon, Tooltip, UnstyledButton } from '@mantine/core';
import { Link, useLocation } from 'react-router-dom';
import { 
  IconHeart, IconBolt, IconDatabase, IconFolder,
  IconRobot, IconHierarchy, IconCommand, IconFlask
} from '@tabler/icons-react';
import { colors, spacing } from '../../theme/tokens';

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  badge?: string;
}

export default function TopNav() {
  const location = useLocation();

  const navItems: NavItem[] = [
    { path: '/', label: 'Health', icon: <IconHeart size={18} /> },
    { path: '/events', label: 'Events', icon: <IconBolt size={18} /> },
    { path: '/data', label: 'Data', icon: <IconDatabase size={18} /> },
    { path: '/files', label: 'Files', icon: <IconFolder size={18} /> },
    { path: '/automation', label: 'Automation', icon: <IconRobot size={18} /> },
    { path: '/flow', label: 'Architecture', icon: <IconHierarchy size={18} /> },
  ];

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/' || location.pathname === '/health';
    return location.pathname.startsWith(path);
  };

  return (
    <Group
      h={56}
      px="xl"
      justify="space-between"
      style={{
        borderBottom: `1px solid ${colors.border.default}`,
        background: colors.background.primary,
      }}
    >
      {/* Logo */}
      <Group gap="sm">
        <Text
          fw={700}
          size="lg"
          style={{
            background: `linear-gradient(135deg, ${colors.eventTypes.created} 0%, ${colors.eventTypes.ai} 100%)`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          SYNAP
        </Text>
        <Badge size="xs" variant="light" color="gray">Admin</Badge>
      </Group>

      {/* Navigation Items */}
      <Group gap={spacing[1]}>
        {navItems.map((item) => (
          <UnstyledButton
            key={item.path}
            component={Link}
            to={item.path}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 16px',
              borderRadius: 8,
              background: isActive(item.path) 
                ? `${colors.eventTypes.created}15` 
                : 'transparent',
              color: isActive(item.path) 
                ? colors.eventTypes.created 
                : colors.text.secondary,
              transition: 'all 0.15s ease',
            }}
          >
            {item.icon}
            <Text size="sm" fw={isActive(item.path) ? 600 : 400}>
              {item.label}
            </Text>
            {item.badge && (
              <Badge size="xs" variant="filled" color="gray">
                {item.badge}
              </Badge>
            )}
          </UnstyledButton>
        ))}
      </Group>

      {/* Actions */}
      <Group gap="xs">
        <Tooltip label="Testing Lab" position="bottom">
          <ActionIcon
            component={Link}
            to="/testing"
            variant="subtle"
            size="lg"
            color={location.pathname === '/testing' ? 'violet' : 'gray'}
          >
            <IconFlask size={20} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Command Menu (⌘K)" position="bottom">
          <ActionIcon variant="subtle" size="lg" color="gray">
            <IconCommand size={20} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Group>
  );
}
