"use client";

/**
 * Offline icon loading for the architecture canvas.
 *
 * `icon-data.json` is ~650 KB, so it is pulled in by a single dynamic import
 * and registered once with `addCollection`. That keeps it a lazy chunk instead
 * of part of the route bundle, and means no request ever reaches the Iconify
 * API -- the canvas works with no network.
 */

import { useSyncExternalStore } from "react";
import { addCollection, Icon } from "@iconify/react";
import {
  Box,
  Braces,
  Clock,
  Cloud,
  Cpu,
  Database,
  DoorOpen,
  ExternalLink,
  Globe,
  HardDrive,
  Inbox,
  Radio,
  Scale,
  Shield,
  Smartphone,
  User,
  Webhook,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { getTech } from "@/lib/arch/tech-catalog";

export type IconLicense = "mit" | "cc0" | "apache-2.0" | "vendor-restricted";

type IconMeta = { source: string; license: IconLicense };

type IconPayload = {
  collection: Parameters<typeof addCollection>[0];
  meta: Record<string, IconMeta>;
};

/* ------------------------------ lazy loading ------------------------------ */

let meta: Record<string, IconMeta> = {};
let ready = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const loadIconSet = (): Promise<void> => {
  if (inflight) {
    return inflight;
  }

  inflight = import("./icon-data.json")
    .then((mod) => {
      const payload = ((mod as { default?: IconPayload }).default ??
        mod) as unknown as IconPayload;

      addCollection(payload.collection);
      meta = payload.meta;
      ready = true;
      listeners.forEach((listener) => listener());
    })
    .catch(() => {
      // A failed load must not break the canvas -- every node falls back to a
      // generic glyph, which is exactly what the pre-load state renders.
      ready = true;
      listeners.forEach((listener) => listener());
    });

  return inflight;
};

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  void loadIconSet();
  return () => void listeners.delete(onChange);
};

/** True once the icon collection is registered. */
export const useIconSet = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => ready,
    () => false,
  );

/**
 * Whether a technology's mark may be recoloured.
 *
 * AWS, Azure and Google forbid modifying their icons -- no recolouring,
 * rotating or cropping. Everything sourced under MIT/CC0/Apache-2.0 is fine.
 * Callers must respect this rather than styling icons unconditionally.
 */
export const canTint = (techId: string | undefined): boolean =>
  !techId || meta[techId]?.license !== "vendor-restricted";

export const iconLicense = (techId: string): IconLicense | undefined =>
  meta[techId]?.license;

/* ------------------------------ generic glyphs ---------------------------- */

/** Primitives with no brand mark, drawn from lucide instead. */
const GENERIC: Record<string, LucideIcon> = {
  client: User,
  browser: Globe,
  mobile: Smartphone,
  "load-balancer": Scale,
  api: Braces,
  gateway: DoorOpen,
  queue: Inbox,
  database: Database,
  cache: Zap,
  "object-storage": HardDrive,
  cdn: Radio,
  worker: Cpu,
  cron: Clock,
  firewall: Shield,
  external: ExternalLink,
  webhook: Webhook,
};

/* -------------------------------- component ------------------------------- */

interface TechIconProps {
  techId?: string;
  className?: string;
  size?: number;
}

/**
 * Renders a technology's mark, falling back through: bundled brand icon ->
 * generic lucide glyph -> a neutral box.
 */
export const TechIcon = ({ techId, className, size = 18 }: TechIconProps) => {
  const loaded = useIconSet();
  const tech = getTech(techId);

  if (tech && tech.icon && loaded) {
    const restricted = !canTint(tech.id);

    return (
      <Icon
        icon={`arch:${tech.id}`}
        width={size}
        height={size}
        // Vendor marks get sizing only. No colour, no filter, no transform --
        // their terms forbid it, so the class is dropped rather than merged.
        className={restricted ? undefined : className}
        data-license={restricted ? "vendor-restricted" : undefined}
      />
    );
  }

  const Glyph = (techId && GENERIC[techId]) || Box;

  return (
    <Glyph
      style={{ width: size, height: size }}
      className={cn("text-neutral-500", className)}
    />
  );
};
