"use client";

import { forwardRef } from "react";

import { cn } from "@/lib/utils";
import type { TaskStatus } from "@/lib/project/types";

/**
 * The small set of shapes every surface is built from.
 *
 * Kept together rather than one file each because they are only useful as a
 * set: the point is that a panel, a badge and a button agree about radius,
 * border and elevation without anyone having to remember the values.
 */

/* --------------------------------- surface -------------------------------- */

/**
 * A surface.
 *
 * Borderless by default. A 1px outline around every element is the signature
 * of an admin template; the products this is measured against separate content
 * with space, a small shift in background, and hover states that appear only on
 * interaction. `bordered` exists for the few places a hard edge genuinely
 * helps -- a popover over unpredictable content, say.
 */
export const Panel = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { bordered?: boolean }
>(({ className, bordered, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-xl bg-panel",
      bordered ? "border border-line shadow-xs" : "shadow-xs ring-1 ring-inset ring-line/60",
      className,
    )}
    {...props}
  />
));
Panel.displayName = "Panel";

/**
 * A section heading.
 *
 * Sections are separated by space rather than a rule. A divider under every
 * heading chops a page into boxes; whitespace lets it read as one document.
 */
export const SectionHeader = ({
  title,
  hint,
  actions,
}: {
  title: string;
  hint?: React.ReactNode;
  actions?: React.ReactNode;
}) => (
  <div className="mb-3 flex items-end justify-between gap-x-4">
    <div className="min-w-0">
      <h2 className="text-[13px] font-medium text-fg">{title}</h2>
      {hint ? <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{hint}</p> : null}
    </div>
    {actions ? <div className="shrink-0">{actions}</div> : null}
  </div>
);

/**
 * The zone at the top of every surface.
 *
 * Its job is to give the page somewhere to begin. Content that starts
 * immediately under the chrome reads as a fragment of a larger page rather than
 * a page in its own right.
 */
export const PageHeader = ({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) => (
  <header className="mb-7 flex items-start justify-between gap-x-6">
    <div className="min-w-0">
      <h1 className="text-[20px] font-semibold leading-tight text-fg">{title}</h1>
      {description ? (
        <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">{description}</p>
      ) : null}
    </div>
    {actions ? <div className="flex shrink-0 items-center gap-x-2">{actions}</div> : null}
  </header>
);

/**
 * A row in a list.
 *
 * Rows are separated by a hairline that only exists between them, and the
 * hover state is a background shift rather than a border change -- borders that
 * light up on hover make a layout feel like it is twitching.
 */
export const Row = ({
  className,
  interactive = true,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) => (
  <div
    className={cn(
      "group relative flex items-center gap-x-3 rounded-lg px-3 py-2.5 transition-colors duration-100",
      interactive && "hover:bg-bg-subtle",
      className,
    )}
    {...props}
  />
);

/* --------------------------------- button --------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-brand text-brand-fg hover:bg-brand-hover shadow-xs",
  secondary: "bg-bg-subtle text-fg hover:bg-line/70",
  ghost: "text-fg-muted hover:bg-bg-subtle hover:text-fg",
  danger: "text-status-danger hover:bg-status-danger/10",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-7 gap-x-1.5 px-2 text-xs",
  md: "h-8 gap-x-1.5 px-3 text-sm",
};

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
  }
>(({ className, variant = "secondary", size = "md", ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "inline-flex shrink-0 items-center justify-center rounded-md font-medium transition-colors",
      "disabled:pointer-events-none disabled:opacity-40",
      BUTTON_VARIANT[variant],
      BUTTON_SIZE[size],
      className,
    )}
    {...props}
  />
));
Button.displayName = "Button";

export const IconButton = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }
>(({ className, variant = "ghost", ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
      "disabled:pointer-events-none disabled:opacity-40",
      BUTTON_VARIANT[variant],
      className,
    )}
    {...props}
  />
));
IconButton.displayName = "IconButton";

/* ---------------------------------- badge --------------------------------- */

export const Badge = ({
  children,
  className,
  tone = "neutral",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "brand" | "success" | "warning" | "danger";
}) => {
  const TONE = {
    neutral: "bg-bg-subtle text-fg-muted",
    brand: "bg-brand-subtle text-brand",
    success: "bg-status-done/12 text-status-done",
    warning: "bg-status-progress/12 text-status-progress",
    danger: "bg-status-danger/12 text-status-danger",
  };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-x-1 rounded px-1.5 py-0.5 text-2xs font-medium",
        TONE[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
};

/* --------------------------------- status --------------------------------- */

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

/** One colour per status, defined once, so nothing drifts between surfaces. */
export const STATUS_COLOR: Record<TaskStatus, string> = {
  backlog: "bg-status-backlog",
  todo: "bg-status-todo",
  in_progress: "bg-status-progress",
  review: "bg-status-review",
  done: "bg-status-done",
};

export const STATUS_TEXT: Record<TaskStatus, string> = {
  backlog: "text-status-backlog",
  todo: "text-status-todo",
  in_progress: "text-status-progress",
  review: "text-status-review",
  done: "text-status-done",
};

export const StatusDot = ({ status, className }: { status: TaskStatus; className?: string }) => (
  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_COLOR[status], className)} />
);

export const StatusBadge = ({ status, pinned }: { status: TaskStatus; pinned?: boolean }) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center gap-x-1.5 rounded px-1.5 py-0.5 text-2xs font-medium",
      "bg-bg-subtle",
      STATUS_TEXT[status],
    )}
    title={pinned ? "Pinned by hand; not derived from the acceptance criteria" : undefined}
  >
    <StatusDot status={status} />
    {STATUS_LABEL[status]}
    {pinned ? <span className="text-fg-subtle">·pinned</span> : null}
  </span>
);

/* -------------------------------- progress -------------------------------- */

export const Progress = ({
  value,
  total,
  className,
  tone = "auto",
}: {
  value: number;
  total: number;
  className?: string;
  tone?: "auto" | "brand";
}) => {
  const pct = total ? (value / total) * 100 : 0;
  const complete = total > 0 && value === total;
  return (
    <span className={cn("block h-1 overflow-hidden rounded-full bg-line", className)}>
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-300",
          tone === "brand" ? "bg-brand" : complete ? "bg-status-done" : "bg-status-progress",
        )}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
};

/* ----------------------------------- kbd ---------------------------------- */

export const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded bg-bg-subtle px-1.5 py-0.5 font-sans text-2xs font-medium text-fg-subtle">
    {children}
  </kbd>
);

/* ------------------------------- empty state ------------------------------ */

export const EmptyState = ({
  icon,
  title,
  children,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) => (
  <div className="flex flex-col items-center px-6 py-16 text-center">
    {icon ? <div className="mb-3 text-fg-subtle">{icon}</div> : null}
    <h2 className="text-sm font-semibold text-fg">{title}</h2>
    {children ? (
      <div className="mx-auto mt-1.5 max-w-md text-sm text-fg-muted">{children}</div>
    ) : null}
    {action ? <div className="mt-4">{action}</div> : null}
  </div>
);

/* ---------------------------------- input --------------------------------- */

export const TextInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-8 w-full rounded-md bg-bg-subtle px-2.5 text-sm text-fg",
      "placeholder:text-fg-subtle",
      "ring-1 ring-inset ring-transparent transition-shadow",
      "focus:bg-panel focus:outline-none focus:ring-brand focus-visible:outline-none",
      className,
    )}
    {...props}
  />
));
TextInput.displayName = "TextInput";

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-8 rounded-md bg-bg-subtle px-2 text-xs text-fg",
      "ring-1 ring-inset ring-transparent transition-shadow",
      "focus:bg-panel focus:outline-none focus:ring-brand focus-visible:outline-none",
      className,
    )}
    {...props}
  />
));
Select.displayName = "Select";

/* -------------------------------- segmented ------------------------------- */

export const Segmented = <T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
}) => (
  <div className="inline-flex items-center gap-x-0.5 rounded-md bg-bg-subtle p-0.5">
    {options.map((option) => (
      <button
        key={option.value}
        onClick={() => onChange(option.value)}
        title={option.title}
        className={cn(
          "rounded px-2 py-1 text-xs font-medium transition-colors",
          value === option.value
            ? "bg-panel text-fg shadow-xs"
            : "text-fg-muted hover:text-fg",
        )}
      >
        {option.label}
      </button>
    ))}
  </div>
);
