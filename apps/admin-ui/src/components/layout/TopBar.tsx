import { Group, Text, ActionIcon, Badge } from "@mantine/core";
import { IconSearch, IconUser, IconMenu2 } from "@tabler/icons-react";
import { colors, layout, typography, spacing } from "../../theme/tokens";

interface TopBarProps {
  onCommandPaletteOpen: () => void;
  onMenuClick?: () => void;
  showMenuButton?: boolean;
}

export default function TopBar({
  onCommandPaletteOpen,
  onMenuClick,
  showMenuButton = false,
}: TopBarProps) {
  return (
    <div
      style={{
        height: layout.topBarHeight,
        borderBottom: `1px solid ${colors.border.default}`,
        backgroundColor: colors.background.primary,
        display: "flex",
        alignItems: "center",
        padding: `0 ${spacing[6]}`,
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}
    >
      <Group justify="space-between" style={{ width: "100%" }}>
        {/* Logo & Title */}
        <Group gap={spacing[3]}>
          {showMenuButton && onMenuClick && (
            <ActionIcon
              variant="subtle"
              size="lg"
              onClick={onMenuClick}
              aria-label="Open navigation menu"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onMenuClick();
                }
              }}
            >
              <IconMenu2 size={20} />
            </ActionIcon>
          )}
          <Text
            size="xl"
            fw={typography.fontWeight.bold}
            style={{
              fontFamily: typography.fontFamily.sans,
              color: colors.text.primary,
            }}
          >
            Synap Control Tower
          </Text>
          <Badge variant="light" color="blue" size="sm">
            V2
          </Badge>
        </Group>

        {/* Actions */}
        <Group gap={spacing[3]}>
          {/* Command Palette Trigger */}
          <ActionIcon
            variant="subtle"
            size="lg"
            onClick={onCommandPaletteOpen}
            style={{
              color: colors.text.secondary,
            }}
            title="Search (⌘K)"
            aria-label="Open command palette (⌘K)"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onCommandPaletteOpen();
              }
            }}
          >
            <IconSearch size={20} />
          </ActionIcon>

          {/* User Menu Placeholder */}
          <ActionIcon
            variant="subtle"
            size="lg"
            style={{
              color: colors.text.secondary,
            }}
            title="User Menu"
            aria-label="Open user menu"
            tabIndex={0}
          >
            <IconUser size={20} />
          </ActionIcon>
        </Group>
      </Group>
    </div>
  );
}
