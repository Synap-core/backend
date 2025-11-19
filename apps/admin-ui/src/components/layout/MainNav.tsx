import { NavLink, ActionIcon, Group, Text } from '@mantine/core';
import { Link, useLocation } from 'react-router-dom';
import {
  IconHome,
  IconSearch,
  IconFlask,
  IconMap,
  IconChevronLeft,
  IconChevronRight,
} from '@tabler/icons-react';
import { colors, layout, spacing, typography } from '../../theme/tokens';

interface MainNavProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  showToggle?: boolean;
  onNavigate?: () => void;
}

export default function MainNav({ collapsed = false, onToggleCollapse, showToggle = false, onNavigate }: MainNavProps) {
  const location = useLocation();

  const navItems = [
    {
      path: '/',
      label: 'Dashboard',
      icon: IconHome,
      description: 'Health Monitoring',
    },
    {
      path: '/investigate',
      label: 'Investigate',
      icon: IconSearch,
      description: 'Incident Investigation',
    },
    {
      path: '/testing',
      label: 'Testing',
      icon: IconFlask,
      description: 'Development & Testing',
    },
    {
      path: '/explore',
      label: 'Explore',
      icon: IconMap,
      description: 'System Exploration',
    },
  ];

  const navWidth = collapsed ? layout.navWidthCollapsed : layout.navWidth;

  return (
    <nav
      style={{
        width: navWidth,
        height: `calc(100vh - ${layout.topBarHeight})`,
        borderRight: `1px solid ${colors.border.default}`,
        backgroundColor: colors.background.primary,
        padding: spacing[4],
        position: 'sticky',
        top: layout.topBarHeight,
        overflowY: 'auto',
        transition: 'width 0.2s ease',
      }}
      aria-label="Main navigation"
    >
      {showToggle && onToggleCollapse && (
        <Group justify="flex-end" mb={spacing[2]}>
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggleCollapse();
              }
            }}
          >
            {collapsed ? <IconChevronRight size={16} /> : <IconChevronLeft size={16} />}
          </ActionIcon>
        </Group>
      )}
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.path;

          return (
            <NavLink
              key={item.path}
              component={Link}
              to={item.path}
              label={collapsed ? undefined : item.label}
              description={collapsed ? undefined : item.description}
              leftSection={<Icon size={20} />}
              active={isActive}
              onClick={onNavigate}
              style={{
                borderRadius: '6px',
                fontFamily: typography.fontFamily.sans,
                fontSize: typography.fontSize.sm,
                fontWeight: isActive ? typography.fontWeight.semibold : typography.fontWeight.normal,
              }}
              aria-label={item.label}
              title={collapsed ? item.label : undefined}
            />
          );
        })}
      </div>

      {/* Divider */}
      <div
        style={{
          height: '1px',
          backgroundColor: colors.border.light,
          margin: `${spacing[6]} 0`,
        }}
      />

      {/* Legacy Pages Section */}
      {!collapsed && (
        <div style={{ marginTop: spacing[6] }}>
          <div
            style={{
              fontSize: typography.fontSize.xs,
              fontWeight: typography.fontWeight.semibold,
              color: colors.text.tertiary,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: spacing[2],
              paddingLeft: spacing[3],
            }}
          >
            Legacy
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[1] }}>
            <NavLink
              component={Link}
              to="/capabilities"
              label="System Capabilities"
              onClick={onNavigate}
              style={{
                borderRadius: '6px',
                fontSize: typography.fontSize.xs,
                color: colors.text.secondary,
              }}
              aria-label="System Capabilities"
            />
            <NavLink
              component={Link}
              to="/publish"
              label="Event Publisher"
              onClick={onNavigate}
              style={{
                borderRadius: '6px',
                fontSize: typography.fontSize.xs,
                color: colors.text.secondary,
              }}
              aria-label="Event Publisher"
            />
          </div>
        </div>
      )}
    </nav>
  );
}
