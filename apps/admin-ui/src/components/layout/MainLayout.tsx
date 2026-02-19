import { useState, useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Drawer, Loader } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import TopNav from "./TopNav";
import MainNav from "./MainNav";
import CommandPalette from "../CommandPalette";
import { useAuth } from "../../lib/auth";
import { colors, breakpoints, layout } from "../../theme/tokens";

export default function MainLayout() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const location = useLocation();
  const { isLoading, isAuthenticated } = useAuth();

  const isMobile = useMediaQuery(`(max-width: ${breakpoints.tablet})`);

  // Auth guard: show spinner while loading, nothing if not authenticated (AuthProvider redirects)
  if (isLoading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.background.secondary,
        }}
      >
        <Loader size="lg" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  // Auto-close drawer on mobile when route changes
  useEffect(() => {
    if (isMobile && navDrawerOpen) {
      setNavDrawerOpen(false);
    }
  }, [location.pathname, isMobile, navDrawerOpen]);

  // Keyboard shortcut for Command Palette (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: colors.background.secondary,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top Bar — full width, sticky */}
      <TopNav onMenuOpen={() => setNavDrawerOpen(true)} />

      {/* Body — flex row: sidebar + content */}
      <div
        style={{
          display: "flex",
          flex: 1,
          overflow: "hidden",
        }}
      >
        {/* Sidebar — desktop only */}
        {!isMobile && (
          <MainNav />
        )}

        {/* Main Content */}
        <main
          style={{
            flex: 1,
            overflowY: "auto",
            minWidth: 0,
          }}
        >
          <Outlet />
        </main>
      </div>

      {/* Mobile Navigation Drawer */}
      <Drawer
        opened={navDrawerOpen}
        onClose={() => setNavDrawerOpen(false)}
        position="left"
        size={layout.navWidth}
        withCloseButton={false}
        styles={{
          body: { padding: 0 },
        }}
      >
        <div
          style={{
            height: "56px",
            borderBottom: `1px solid ${colors.border.default}`,
            display: "flex",
            alignItems: "center",
            padding: "0 16px",
            fontWeight: 700,
            fontSize: "16px",
            background: `linear-gradient(135deg, ${colors.eventTypes.created} 0%, ${colors.eventTypes.ai} 100%)`,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          SYNAP Admin
        </div>
        <MainNav onNavigate={() => setNavDrawerOpen(false)} />
      </Drawer>

      {/* Command Palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />
    </div>
  );
}
