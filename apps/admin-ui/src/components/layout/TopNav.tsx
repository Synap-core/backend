import { IconMenu2, IconUser, IconLogout } from "@tabler/icons-react";
import { Button } from "@heroui/react";
import { Dropdown } from "@heroui/react";
import { useAuth } from "../../lib/auth";
import { useWorkspace } from "../../lib/workspace";
import BrandMark from "./BrandMark";
import SearchCommandButton from "./SearchCommandButton";

interface TopNavProps {
  onMenuOpen?: () => void;
  onCommandPaletteOpen?: () => void;
}

export default function TopNav({
  onMenuOpen,
  onCommandPaletteOpen,
}: TopNavProps) {
  const { user, logout } = useAuth();
  const { workspaceName } = useWorkspace();

  return (
    <header className="sticky top-0 z-100 flex h-[60px] shrink-0 items-center justify-between border-b border-divider bg-background/95 px-6 backdrop-blur-md">
      <div className="flex items-center gap-3">
        {onMenuOpen ? (
          <Button
            isIconOnly
            variant="ghost"
            className="md:hidden"
            aria-label="Open navigation"
            onPress={onMenuOpen}
          >
            <IconMenu2 size={20} />
          </Button>
        ) : null}
        <BrandMark compact={false} />
        {workspaceName ? (
          <span className="flex items-center gap-2 text-small text-default-500">
            <span className="opacity-50">/</span>
            <span className="text-default-600">{workspaceName}</span>
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        <SearchCommandButton compact onPress={onCommandPaletteOpen} />

        {user ? (
          <Dropdown.Root>
            <Dropdown.Trigger>
              <Button isIconOnly variant="ghost" aria-label="Account menu">
                <IconUser size={20} />
              </Button>
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                onAction={(key) => {
                  if (key === "logout") logout();
                }}
              >
                <Dropdown.Section>
                  <Dropdown.Item
                    id="email"
                    isDisabled
                    textValue={user.email}
                    className="cursor-default opacity-100"
                  >
                    <div className="flex flex-col gap-0.5 py-1">
                      <span className="text-xs font-medium text-default-foreground">
                        {user.email}
                      </span>
                      {user.name ? (
                        <span className="text-xs text-default-500">
                          {user.name}
                        </span>
                      ) : null}
                    </div>
                  </Dropdown.Item>
                </Dropdown.Section>
                <Dropdown.Item
                  id="logout"
                  textValue="Log out"
                  className="text-danger"
                >
                  <span className="inline-flex items-center gap-2">
                    <IconLogout size={16} />
                    Log out
                  </span>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
        ) : null}
      </div>
    </header>
  );
}
