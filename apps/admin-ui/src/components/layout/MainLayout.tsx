import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import TopNav from "./TopNav";
import MainNav from "./MainNav";
import CommandPalette from "../CommandPalette";
import { colors, breakpoints, layout } from "../../theme/tokens";

export default function MainLayout() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);

  // Default to false (desktop) to avoid flash — mobile users get a single re-render
  const isMobile = useMediaQuery(`(max-width: ${breakpoints.tablet})`, false);

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
      }}
    >
      {/* Top Bar — fixed at top, full width */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 100,
          height: layout.topBarHeight,
        }}
      >
        <TopNav onMenuOpen={() => setNavDrawerOpen(true)} />
      </div>

      {/* Sidebar — fixed left, below top bar (desktop only) */}
      {!isMobile && (
        <div
          style={{
            position: "fixed",
            top: layout.topBarHeight,
            left: 0,
            bottom: 0,
            width: layout.navWidth,
            zIndex: 99,
            overflowY: "auto",
          }}
        >
          <MainNav />
        </div>
      )}

      {/* Main Content — offset by top bar height and sidebar width */}
      <main
        style={{
          marginTop: layout.topBarHeight,
          marginLeft: isMobile ? 0 : layout.navWidth,
          minHeight: `calc(100vh - ${layout.topBarHeight})`,
        }}
      >
        <Outlet />
      </main>

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
