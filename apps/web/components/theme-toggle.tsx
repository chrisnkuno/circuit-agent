"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "circuit-nova-theme";

export type Theme = "dark" | "light";

function systemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" ? "light" : stored === "dark" ? "dark" : null;
  } catch {
    return null;
  }
}

/** Applies the theme to <html data-theme=...> and records it for the no-flash
 * script in layout.tsx to agree with on the next visit. */
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.add("theme-switching");
  window.setTimeout(() => document.documentElement.classList.remove("theme-switching"), 500);
}

/** A quiet circuit switch in the nav: taps between dark and light. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(readStoredTheme() ?? systemTheme());
    applyTheme(readStoredTheme() ?? systemTheme());
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (!readStoredTheme()) applyTheme(systemTheme());
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Theme still applies for this session even if storage is unavailable.
      }
      applyTheme(next);
      return next;
    });
  }, []);

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      role="switch"
      aria-checked={theme === "light"}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      <svg className="theme-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {theme === "dark" ? (
          <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="1.3" />
        ) : (
          <circle cx="8" cy="8" r="4.5" fill="currentColor" />
        )}
        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M13 3l-1.5 1.5M3 13l1.5-1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </button>
  );
}