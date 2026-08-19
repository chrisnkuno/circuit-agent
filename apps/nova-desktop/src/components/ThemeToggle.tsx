import { useEffect, useState } from "react";
import {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  systemPrefersDark,
  themeLabel,
  watchSystemTheme,
  writeStoredTheme,
  THEME_CHOICES,
  type ResolvedTheme,
  type ThemeChoice,
} from "../lib/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

/**
 * The appearance control: a menu of three, not a switch of two.
 *
 * A two-state switch cannot express "follow the machine", and that is the state most people
 * actually want — it is why the app tracked `prefers-color-scheme` before there was any control at
 * all. A menu can hold all three, say which is current, and show what the current one *resolves to*
 * right now, which is the one thing a two-state switch genuinely cannot: with "System" chosen,
 * neither a sun nor a moon is the truth.
 *
 * The glyph is drawn rather than lettered, and drawn as two marks that mean the same thing at any
 * size: a filled disc for dark, an open ring for light. No icon font, no SVG sprite sheet, no third
 * dependency — this window has exactly one pictorial element and it does not need a library.
 */
export function ThemeToggle({ onResolved }: { onResolved?: (resolved: ResolvedTheme) => void } = {}) {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStoredTheme());
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());

  // The machine is followed for as long as the window is open, not only at boot: someone whose OS
  // flips to dark at sunset expects the app to come with it, and "System" that only means "system
  // as it was when you launched" is the kind of half-truth that reads as a bug.
  useEffect(() => watchSystemTheme(setPrefersDark), []);

  const resolved = resolveTheme(choice, prefersDark);

  useEffect(() => {
    if (globalThis.document) applyTheme(resolved, globalThis.document.documentElement);
    onResolved?.(resolved);
  }, [resolved, onResolved]);

  function pick(next: string) {
    const value = THEME_CHOICES.find((candidate) => candidate === next);
    if (!value) return;
    setChoice(value);
    writeStoredTheme(value);
  }

  return (
    <DropdownMenu>
      <Tooltip label={`Appearance — ${themeLabel(choice)}${choice === "system" ? ` (${resolved} right now)` : ""}`}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="theme-trigger" aria-label={`Appearance: ${themeLabel(choice)}`}>
            <ThemeMark resolved={resolved} />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent>
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={choice} onValueChange={pick}>
          {THEME_CHOICES.map((candidate) => (
            <DropdownMenuRadioItem key={candidate} value={candidate}>
              {themeLabel(candidate)}
              {/* Only "System" gets a right-hand column, because only "System" is ambiguous: it is
                  the one row whose meaning depends on something outside this window. */}
              {candidate === "system" ? <DropdownMenuShortcut>{resolved}</DropdownMenuShortcut> : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A filled disc for dark, an open ring for light. Legible at 14px, which an icon set is often not. */
function ThemeMark({ resolved }: { resolved: ResolvedTheme }) {
  return (
    <svg className="theme-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <circle
        cx="8"
        cy="8"
        r="5"
        fill={resolved === "dark" ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  );
}
