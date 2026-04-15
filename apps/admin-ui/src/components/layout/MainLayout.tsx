import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import TopNav from "./TopNav";
import MainNav from "./MainNav";
import CommandPalette from "../CommandPalette";
import { layout, breakpoints } from "../../theme/tokens";
import { useMediaQuery } from "../../hooks/useMediaQuery";
const SIDEBAR_COLLAPSED_KEY = "synap-admin-sidebar-collapsed";

export default function MainLayout() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const isMobile = useMediaQuery(`(max-width: ${breakpoints.tablet})`, false);

  useEffect(() => {
    try {
      if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") {
        setSidebarCollapsed(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

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

  const navWidth = isMobile
    ? layout.navWidth
    : sidebarCollapsed
      ? layout.navWidthCollapsed
      : layout.navWidth;

  return (
    <div className="min-h-screen bg-background">
      <div
        className="fixed left-0 right-0 top-0 z-100"
        style={{ height: layout.topBarHeight }}
      >
        <TopNav
          onMenuOpen={() => setNavDrawerOpen(true)}
          onCommandPaletteOpen={() => setCommandPaletteOpen(true)}
        />
      </div>

      {!isMobile ? (
        <div
          className="fixed bottom-0 left-0 z-99 overflow-y-auto border-r border-divider bg-content1 transition-[width] duration-200 ease-out"
          style={{
            top: layout.topBarHeight,
            width: navWidth,
          }}
        >
          <MainNav
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleSidebarCollapsed}
            onCommandPaletteOpen={() => setCommandPaletteOpen(true)}
          />
        </div>
      ) : null}

      <main
        className="min-h-[calc(100vh-60px)] transition-[margin-left] duration-200 ease-out"
        style={{
          marginTop: layout.topBarHeight,
          marginLeft: isMobile ? 0 : navWidth,
        }}
      >
        <Outlet
          context={{ openCommandPalette: () => setCommandPaletteOpen(true) }}
        />
      </main>

      {isMobile && navDrawerOpen ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-200 bg-black/40"
            aria-label="Close navigation"
            onClick={() => setNavDrawerOpen(false)}
          />
          <div className="fixed bottom-0 left-0 top-[60px] z-201 w-[min(280px,90vw)] overflow-y-auto border-r border-divider bg-content1 shadow-lg">
            <MainNav
              onNavigate={() => setNavDrawerOpen(false)}
              onCommandPaletteOpen={() => {
                setNavDrawerOpen(false);
                setCommandPaletteOpen(true);
              }}
            />
          </div>
        </>
      ) : null}

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />
    </div>
  );
}
