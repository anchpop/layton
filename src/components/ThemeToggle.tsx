import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const KEY = "layton:theme";

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(KEY) as Theme | null) ?? "system",
  );

  useEffect(() => {
    apply(theme);
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  }, [theme]);

  return [theme, setTheme];
}

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();

  const next: Record<Theme, Theme> = {
    system: "light",
    light: "dark",
    dark: "system",
  };
  const label: Record<Theme, string> = {
    system: "Auto",
    light: "Light",
    dark: "Dark",
  };

  return (
    <button
      type="button"
      onClick={() => setTheme(next[theme])}
      title={`Theme: ${label[theme]} — click to change`}
      className="underline underline-offset-4"
      style={{ color: "var(--ink-muted)" }}
    >
      {label[theme]}
    </button>
  );
}
