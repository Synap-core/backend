import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Drawer } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import TopNav from './TopNav';
import MainNav from './MainNav';
import CommandPalette from '../CommandPalette';
import { colors, breakpoints } from '../../theme/tokens';

export default function MainLayout() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const location = useLocation();
  
  // Media queries for responsive behavior
  const isMobile = useMediaQuery(`(max-width: ${breakpoints.tablet})`);
  
  // Auto-close drawer on mobile when route changes
  useEffect(() => {
    if (isMobile && navDrawerOpen) {
      setNavDrawerOpen(false);
    }
  }, [location.pathname, isMobile, navDrawerOpen]);

  // Keyboard shortcut for Command Palette (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: colors.background.secondary,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top Navigation */}
      <TopNav />

      {/* Main Content Area */}
      <main
        style={{
          flex: 1,
          width: '100%',
          overflowY: 'auto',
        }}
      >
        <Outlet />
      </main>

      {/* Mobile Navigation Drawer (fallback) */}
      <Drawer
        opened={navDrawerOpen}
        onClose={() => setNavDrawerOpen(false)}
        position="left"
        size="280px"
        title="Navigation"
        styles={{
          header: {
            borderBottom: `1px solid ${colors.border.default}`,
          },
        }}
      >
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
