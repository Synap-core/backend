/**
 * Design Tokens - Control Tower V2
 *
 * Centralized design system with semantic colors, typography, and spacing.
 * Based on the UX Redesign Plan for consistent, accessible UI.
 */

/**
 * Color Palette
 */
export const colors = {
  // Semantic colors for system status
  semantic: {
    success: "var(--color-success)", // Successful operations
    warning: "var(--color-warning)", // Warnings, degraded state
    error: "var(--color-danger)", // Errors, critical state
    info: "var(--color-primary)", // Informational
  },

  // Health status colors
  health: {
    healthy: "var(--color-success)",
    degraded: "var(--color-warning)",
    critical: "var(--color-danger)",
  },

  // Event type colors for visual distinction
  eventTypes: {
    created: "var(--color-secondary)", // Creation events
    updated: "var(--color-primary)", // Update events
    deleted: "var(--color-danger)", // Deletion events
    ai: "var(--color-warning)", // AI-related events
    system: "var(--color-default-500)", // System events
    error: "var(--color-danger)", // Error events
  },

  // Background and surface colors
  background: {
    primary: "var(--color-background)", // Main background
    secondary: "var(--color-content1)", // Secondary backgrounds
    elevated: "var(--color-content1)", // Elevated surfaces
    hover: "var(--color-default-100)", // Hover states
    active: "var(--color-default-200)", // Active states
  },

  // Border colors
  border: {
    light: "var(--color-divider)", // Subtle borders
    default: "var(--color-divider)", // Default borders
    strong: "var(--color-default-300)", // Strong borders
    interactive: "var(--color-primary)", // Interactive elements
  },

  // Text colors
  text: {
    primary: "var(--color-foreground)", // Primary text
    secondary: "var(--color-default-600)", // Secondary text
    tertiary: "var(--color-default-500)", // Tertiary text
    disabled: "var(--color-default-300)", // Disabled text
    inverse: "var(--color-background)", // Text on dark backgrounds
  },

  // Interactive colors
  interactive: {
    primary: "var(--color-primary)",
    primaryHover: "color-mix(in oklab, var(--color-primary) 88%, black 12%)",
    primaryActive: "color-mix(in oklab, var(--color-primary) 80%, black 20%)",
    secondary: "var(--color-default-500)",
    secondaryHover: "var(--color-default-700)",
  },
} as const;

/**
 * Typography
 */
export const typography = {
  // Font families
  fontFamily: {
    sans: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace',
  },

  // Font sizes (rem scale)
  fontSize: {
    xs: "0.75rem", // 12px - Metadata, timestamps, badges
    sm: "0.875rem", // 14px - Body text, secondary content
    base: "1rem", // 16px - Default body text
    lg: "1.125rem", // 18px - Subheadings
    xl: "1.25rem", // 20px - Page titles
    "2xl": "1.5rem", // 24px - Section headings
    "3xl": "1.875rem", // 30px - Large headings
  },

  // Font weights
  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },

  // Line heights
  lineHeight: {
    tight: 1.25,
    normal: 1.5,
    relaxed: 1.75,
  },
} as const;

/**
 * Spacing Scale (4px base unit)
 */
export const spacing = {
  0: "0",
  0.5: "0.125rem", // 2px
  1: "0.25rem", // 4px
  2: "0.5rem", // 8px
  3: "0.75rem", // 12px
  4: "1rem", // 16px - Default component padding
  5: "1.25rem", // 20px
  6: "1.5rem", // 24px - Section spacing
  8: "2rem", // 32px - Page margins
  10: "2.5rem", // 40px
  12: "3rem", // 48px - Major sections
  16: "4rem", // 64px - Page padding
  20: "5rem", // 80px
  24: "6rem", // 96px
} as const;

/**
 * Border Radius
 */
export const borderRadius = {
  none: "0",
  sm: "0.125rem", // 2px
  base: "0.25rem", // 4px - Default
  md: "0.375rem", // 6px
  lg: "0.5rem", // 8px
  xl: "0.75rem", // 12px
  "2xl": "1rem", // 16px
  full: "9999px", // Fully rounded
} as const;

/**
 * Shadows
 */
export const shadows = {
  none: "none",
  sm: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  base: "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)",
  md: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
  lg: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
  xl: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
} as const;

/**
 * Z-Index Scale
 */
export const zIndex = {
  base: 0,
  dropdown: 1000,
  sticky: 1100,
  overlay: 1200,
  modal: 1300,
  popover: 1400,
  toast: 1500,
  tooltip: 1600,
} as const;

/**
 * Breakpoints for responsive design
 */
export const breakpoints = {
  mobile: "640px", // < 640px - Mobile
  tablet: "768px", // 640px - 1024px - Tablet
  desktop: "1024px", // > 1024px - Desktop
  wide: "1280px", // > 1280px - Wide screens
} as const;

/**
 * Transitions
 */
export const transitions = {
  fast: "150ms cubic-bezier(0.4, 0, 0.2, 1)",
  base: "200ms cubic-bezier(0.4, 0, 0.2, 1)",
  slow: "300ms cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

/**
 * Layout dimensions
 */
export const layout = {
  // TopBar height
  topBarHeight: "60px",

  // MainNav width
  navWidth: "250px",
  navWidthCollapsed: "60px",

  // Content max width
  contentMaxWidth: "1400px",

  // Sidebar width
  sidebarWidth: "320px",
} as const;

/**
 * Icon sizes
 */
export const iconSize = {
  xs: "14px",
  sm: "16px",
  base: "20px",
  lg: "24px",
  xl: "32px",
} as const;

/**
 * Helper function to get color with opacity
 */
export function withOpacity(color: string, opacity: number): string {
  if (color.startsWith("var(") || color.includes("color-mix(")) {
    return `color-mix(in oklab, ${color} ${Math.round(opacity * 100)}%, transparent)`;
  }
  // Convert hex to rgba
  const hex = color.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Type exports for TypeScript
 */
export type SemanticColor = keyof typeof colors.semantic;
export type HealthStatus = keyof typeof colors.health;
export type EventType = keyof typeof colors.eventTypes;
export type Spacing = keyof typeof spacing;
export type FontSize = keyof typeof typography.fontSize;
