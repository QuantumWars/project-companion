"use client";

import { ThemeProvider as NextThemes } from "next-themes";

/**
 * Light and dark are both first-class.
 *
 * `defaultTheme="system"` so the app matches whatever the person's editor and
 * terminal are already set to -- this sits beside them all day, and being the
 * one bright window is worse than any palette choice.
 *
 * `disableTransitionOnChange` stops every element animating its colours at once
 * when the theme flips, which reads as a glitch rather than a transition.
 */
export const ThemeProvider = ({ children }: { children: React.ReactNode }) => (
  <NextThemes attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    {children}
  </NextThemes>
);
