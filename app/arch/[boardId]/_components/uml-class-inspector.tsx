"use client";

import { nanoid } from "nanoid";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { UmlClassData, UmlMember, UmlVisibility } from "@/types/arch";

/**
 * Attribute and method editor for a UML class.
 *
 * Without it a class can be dropped on the canvas and named, and then nothing:
 * `attributes` and `methods` had no way in at all, so every UML diagram was a
 * page of empty boxes. Deliberately the same shape as the table inspector,
 * because a class body and a table body are the same interaction -- an ordered
 * list of typed, named members that can be added, retyped, reordered, removed.
 *
 * Member ids are stable and never regenerated on edit. Nothing joins on them
 * today the way an ER edge joins on a column id, but the cost of keeping them
 * stable is nothing and the cost of discovering later that they were not is a
 * silent detachment.
 */

/** The four UML visibilities, in the order the notation lists them. */
const VISIBILITY: { value: UmlVisibility; glyph: string; title: string }[] = [
  { value: "public", glyph: "+", title: "Public" },
  { value: "protected", glyph: "#", title: "Protected" },
  { value: "private", glyph: "-", title: "Private" },
  { value: "package", glyph: "~", title: "Package" },
];

interface UmlClassInspectorProps {
  data: UmlClassData;
  onChange: (patch: Partial<UmlClassData>) => void;
}

export const UmlClassInspector = ({ data, onChange }: UmlClassInspectorProps) => (
  <aside className="absolute right-2 top-16 z-20 flex max-h-[calc(100vh-5rem)] w-[320px] flex-col rounded-lg border border-line bg-panel shadow-lg">
    <div className="border-b border-line p-3">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
        Class
      </p>
      <div className="mb-2 flex gap-x-2">
        <Input
          value={data.stereotype ?? ""}
          placeholder="interface"
          title="Stereotype, shown in guillemets above the name"
          onChange={(e) => onChange({ stereotype: e.target.value || undefined })}
          className="h-8 w-[104px] text-xs"
        />
        <Input
          value={data.label}
          placeholder="ClassName"
          onChange={(e) => onChange({ label: e.target.value })}
          className={cn("h-8 flex-1 font-medium", data.abstract && "italic")}
        />
      </div>
      <label className="flex items-center gap-x-2 text-xs text-fg-muted">
        <input
          type="checkbox"
          checked={Boolean(data.abstract)}
          onChange={(e) => onChange({ abstract: e.target.checked || undefined })}
          className="h-3 w-3"
        />
        Abstract
      </label>
    </div>

    <div className="flex-1 overflow-y-auto">
      <MemberList
        title="Attributes"
        placeholder="name"
        typePlaceholder="string"
        members={data.attributes ?? []}
        onChange={(attributes) => onChange({ attributes })}
      />
      <MemberList
        title="Methods"
        // No parentheses: the node draws them, so a name carrying its own
        // renders as `doThing()()`.
        placeholder="doThing"
        typePlaceholder="void"
        members={data.methods ?? []}
        onChange={(methods) => onChange({ methods })}
      />
    </div>
  </aside>
);

/**
 * One of the two compartments.
 *
 * Attributes and methods differ only in what the type column means -- a field's
 * type, or a return type -- so they are one component given different labels
 * rather than two that would drift apart.
 */
const MemberList = ({
  title,
  placeholder,
  typePlaceholder,
  members,
  onChange,
}: {
  title: string;
  placeholder: string;
  typePlaceholder: string;
  members: UmlMember[];
  onChange: (members: UmlMember[]) => void;
}) => {
  const update = (id: string, patch: Partial<UmlMember>) =>
    onChange(members.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const move = (index: number, delta: number) => {
    const next = [...members];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const cycleVisibility = (member: UmlMember) => {
    const at = VISIBILITY.findIndex((v) => v.value === (member.visibility ?? "public"));
    update(member.id, { visibility: VISIBILITY[(at + 1) % VISIBILITY.length].value });
  };

  return (
    <div className="border-b border-line p-2 last:border-b-0">
      <div className="mb-1 flex items-center justify-between px-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
          {title}
        </p>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          title={`Add ${title.toLowerCase().replace(/s$/, "")}`}
          onClick={() =>
            onChange([...members, { id: nanoid(8), name: "", visibility: "public" }])
          }
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {members.length === 0 ? (
        <p className="px-1 py-3 text-center text-xs text-fg-subtle">None yet.</p>
      ) : null}

      {members.map((member, index) => (
        <div key={member.id} className="group mb-1 flex items-center gap-x-1">
          {/* One button cycling four states, rather than four radios per row:
              a class can have twenty members and the panel is 320px wide. */}
          <button
            type="button"
            title={`${VISIBILITY.find((v) => v.value === (member.visibility ?? "public"))?.title} - click to change`}
            onClick={() => cycleVisibility(member)}
            className="h-7 w-6 shrink-0 rounded border border-line font-mono text-xs text-fg-muted transition-colors hover:border-brand hover:text-fg"
          >
            {VISIBILITY.find((v) => v.value === (member.visibility ?? "public"))?.glyph}
          </button>

          <Input
            value={member.name}
            placeholder={placeholder}
            onChange={(e) => update(member.id, { name: e.target.value })}
            className={cn("h-7 flex-1 text-xs", member.isStatic && "underline")}
          />
          <Input
            value={member.type ?? ""}
            placeholder={typePlaceholder}
            onChange={(e) => update(member.id, { type: e.target.value || undefined })}
            className="h-7 w-[84px] text-xs text-fg-muted"
          />

          <button
            type="button"
            title="Static"
            onClick={() => update(member.id, { isStatic: !member.isStatic || undefined })}
            className={cn(
              "h-7 w-6 shrink-0 rounded border text-[10px] font-medium transition-colors",
              member.isStatic
                ? "border-brand bg-brand/10 text-brand"
                : "border-line text-fg-subtle hover:text-fg",
            )}
          >
            S
          </button>

          <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            <Button size="icon" variant="ghost" className="h-7 w-5" onClick={() => move(index, -1)} title="Move up">
              <ChevronUp className="h-3 w-3" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-5" onClick={() => move(index, 1)} title="Move down">
              <ChevronDown className="h-3 w-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-5 text-fg-subtle hover:text-danger"
              onClick={() => onChange(members.filter((m) => m.id !== member.id))}
              title="Remove"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
};
