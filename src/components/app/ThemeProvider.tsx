"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";

const ThemeContext = createContext<{
  theme: Theme;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
}>({
  theme: "light",
  toggle: () => undefined,
  setTheme: () => undefined,
});

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.style.colorScheme = theme;
}

function persistTheme(theme: Theme) {
  window.localStorage.setItem("custara-theme", theme);
  document.cookie = `custara-theme=${encodeURIComponent(theme)}; path=/; max-age=31536000; SameSite=Lax`;
}

export function ThemeProvider({
  children,
  initialTheme = "light",
}: {
  children: React.ReactNode;
  initialTheme?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  useEffect(() => {
    const stored = window.localStorage.getItem("custara-theme");
    const fromStorage: Theme | null = stored === "light" || stored === "dark" ? stored : null;
    const next = fromStorage || initialTheme;
    setThemeState(next);
    applyTheme(next);
    // Keep cookie in sync so the next SSR paint matches without an inline script
    persistTheme(next);
  }, [initialTheme]);

  function setTheme(next: Theme) {
    setThemeState(next);
    persistTheme(next);
    applyTheme(next);
  }

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        toggle: () => setTheme(theme === "dark" ? "light" : "dark"),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      className="btn btn-secondary min-w-[3.75rem]"
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Light mode" : "Dark mode"}
    >
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}
