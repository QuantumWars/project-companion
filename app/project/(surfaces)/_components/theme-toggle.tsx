"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
  { value: "system", icon: Monitor, label: "System" },
] as const;

/**
 * Three states, not two.
 *
 * "System" has to be reachable, because someone whose OS switches at dusk
 * wants this to switch with it. A two-way toggle silently pins the theme the
 * first time it is touched.
 */
export const ThemeToggle = () => {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // The active theme is unknown until the client reads it, so render the
  // control inert rather than guessing and flipping on hydration.
  useEffect(() => setMounted(true), []);

  return (
    <div className="inline-flex items-center gap-x-0.5 rounded-md border border-line bg-panel p-0.5">
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          title={label}
          aria-label={label}
          aria-pressed={mounted ? theme === value : undefined}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded transition-colors",
            mounted && theme === value
              ? "bg-bg-subtle text-fg"
              : "text-fg-subtle hover:text-fg",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
};
