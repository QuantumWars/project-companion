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

export const Panel = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-xl border border-line bg-panel shadow-xs",
        className,
      )}
      {...props}
    />
  ),
);
Panel.displayName = "Panel";

export const PanelHeader = ({
  title,
  hint,
  actions,
  icon,
}: {
  title: string;
  hint?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
}) => (
  <div className="flex items-start justify-between gap-x-3 border-b border-line px-4 py-3">
    <div className="min-w-0">
      <h2 className="flex items-center gap-x-1.5 text-xs font-semibold uppercase tracking-wider text-fg-muted">
        {icon}
        {title}
      </h2>
      {hint ? <p className="mt-1 text-xs text-fg-muted">{hint}</p> : null}
    </div>
    {actions ? <div className="shrink-0">{actions}</div> : null}
  </div>
);

/* --------------------------------- button --------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-brand text-brand-fg hover:bg-brand-hover shadow-xs",
  secondary: "border border-line bg-panel text-fg hover:bg-bg-subtle shadow-xs",
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
    neutral: "bg-bg-subtle text-fg-muted ring-line",
    brand: "bg-brand-subtle text-brand ring-brand-border",
    success: "bg-status-done/10 text-status-done ring-status-done/25",
    warning: "bg-status-progress/10 text-status-progress ring-status-progress/25",
    danger: "bg-status-danger/10 text-status-danger ring-status-danger/25",
  };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-x-1 rounded px-1.5 py-0.5 text-2xs font-medium ring-1 ring-inset",
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
      "bg-bg-subtle ring-1 ring-inset ring-line",
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
  <kbd className="rounded border border-line bg-bg-subtle px-1 py-0.5 font-sans text-2xs font-medium text-fg-subtle">
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
  <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong bg-panel px-6 py-12 text-center">
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
      "h-8 w-full rounded-md border border-line bg-panel px-2.5 text-sm text-fg",
      "placeholder:text-fg-subtle",
      "transition-colors focus:border-brand focus:outline-none focus-visible:outline-none",
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
      "h-8 rounded-md border border-line bg-panel px-2 text-xs text-fg",
      "transition-colors focus:border-brand focus:outline-none focus-visible:outline-none",
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
  <div className="inline-flex items-center gap-x-0.5 rounded-md border border-line bg-panel p-0.5">
    {options.map((option) => (
      <button
        key={option.value}
        onClick={() => onChange(option.value)}
        title={option.title}
        className={cn(
          "rounded px-2 py-1 text-xs font-medium transition-colors",
          value === option.value
            ? "bg-brand text-brand-fg"
            : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
        )}
      >
        {option.label}
      </button>
    ))}
  </div>
);
