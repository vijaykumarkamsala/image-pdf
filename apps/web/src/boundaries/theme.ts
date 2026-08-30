import { useEffect, useMemo, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const THEME_KEY = "ipw-theme";

export function readThemePreference(): ThemePreference {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function useThemePreference() {
  const media = useMemo(() => window.matchMedia("(prefers-color-scheme: dark)"), []);
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference);
  const [systemDark, setSystemDark] = useState(media.matches);
  const theme = resolveTheme(preference, systemDark);
  useEffect(() => {
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [media]);
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
  const setPreference = (value: ThemePreference) => {
    localStorage.setItem(THEME_KEY, value);
    setPreferenceState(value);
  };
  return { preference, theme, setPreference };
}
