import { Link } from "react-router-dom";
import { Text, cn } from "@heroui/react";

export interface NavListItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

export interface NavListSection {
  label: string;
  items: NavListItem[];
}

interface NavListItemButtonProps {
  item: NavListItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}

export function NavListItemButton({
  item,
  active,
  collapsed,
  onNavigate,
}: NavListItemButtonProps) {
  const Icon = item.icon;

  return (
    <Link
      to={item.path}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      className={cn(
        "group relative flex items-center text-sm outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-primary/30",
        collapsed
          ? "justify-center rounded-2xl p-2.5"
          : "gap-3 rounded-xl px-3 py-2.5",
        active
          ? "bg-[var(--admin-fluid-selected)] font-semibold text-foreground shadow-sm"
          : "text-default-700 hover:bg-default-100/90 hover:text-foreground"
      )}
      aria-current={active ? "page" : undefined}
    >
      {!collapsed && active ? (
        <span
          className="absolute left-0 top-1/2 h-7 w-1 -translate-y-1/2 rounded-r-full bg-primary"
          aria-hidden
        />
      ) : null}
      <span
        className={cn(
          "flex shrink-0 items-center justify-center transition-colors",
          collapsed ? "h-9 w-9 rounded-2xl" : "h-8 w-8 rounded-xl",
          active
            ? "bg-primary/16 text-primary"
            : "bg-default-100 text-default-500 group-hover:bg-default-200 group-hover:text-default-700"
        )}
      >
        <Icon size={collapsed ? 18 : 17} aria-hidden />
      </span>
      {collapsed ? (
        <span className="sr-only">{item.label}</span>
      ) : (
        <span className="min-w-0 flex-1 truncate leading-snug">
          {item.label}
        </span>
      )}
    </Link>
  );
}

interface NavListSectionBlockProps {
  section: NavListSection;
  collapsed: boolean;
  isActive: (path: string) => boolean;
  onNavigate?: () => void;
}

export function NavListSectionBlock({
  section,
  collapsed,
  isActive,
  onNavigate,
}: NavListSectionBlockProps) {
  return (
    <section>
      {!collapsed ? (
        <div className="mb-2 px-1 pt-1">
          <Text className="text-[10px] font-semibold uppercase tracking-[0.12em] text-default-500">
            {section.label}
          </Text>
        </div>
      ) : null}
      <div
        className="flex flex-col gap-1"
        role="list"
        aria-label={section.label}
      >
        {section.items.map((item) => (
          <NavListItemButton
            key={item.path}
            item={item}
            active={isActive(item.path)}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </section>
  );
}
