import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import TopNav from "./TopNav";
import MainNav from "./MainNav";
import CommandPalette from "../CommandPalette";
import { layout, breakpoints } from "../../theme/tokens";
import { useMediaQuery } from "../../hooks/useMediaQuery";

export default function MainLayout() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);

  const isMobile = useMediaQuery(`(max-width: ${breakpoints.tablet})`, false);

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
    <div className="min-h-screen bg-[var(--pod-surface-2)]">
      <div
        className="fixed left-0 right-0 top-0 z-[100]"
        style={{ height: layout.topBarHeight }}
      >
        <TopNav
          onMenuOpen={() => setNavDrawerOpen(true)}
          onCommandPaletteOpen={() => setCommandPaletteOpen(true)}
        />
      </div>

      {!isMobile ? (
        <div
          className="fixed bottom-0 left-0 z-[99] overflow-y-auto"
          style={{
            top: layout.topBarHeight,
            width: layout.navWidth,
          }}
        >
          <MainNav />
        </div>
      ) : null}

      <main
        className="min-h-[calc(100vh-60px)]"
        style={{
          marginTop: layout.topBarHeight,
          marginLeft: isMobile ? 0 : layout.navWidth,
        }}
      >
        <Outlet />
      </main>

      {isMobile && navDrawerOpen ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[200] bg-black/40"
            aria-label="Close navigation"
            onClick={() => setNavDrawerOpen(false)}
          />
          <div className="fixed bottom-0 left-0 top-[60px] z-[201] w-[min(280px,90vw)] overflow-y-auto border-r border-divider bg-background shadow-lg">
            <div className="border-b border-divider px-4 py-3">
              <span className="bg-gradient-to-br from-[var(--pod-accent)] to-[var(--pod-accent-2)] bg-clip-text text-base font-bold text-transparent">
                Synap Pod
              </span>
            </div>
            <MainNav onNavigate={() => setNavDrawerOpen(false)} />
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
