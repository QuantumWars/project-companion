"use client";

/**
 * Keeps edge labels from landing on top of each other.
 *
 * Each edge computes its label position from its own path midpoint, so two
 * edges running between the same pair of columns produce the same coordinates
 * and the labels overlap into an unreadable smudge. No edge can fix that
 * alone -- it needs to know where the other labels are.
 *
 * Every label registers its natural box here; a single pass nudges any that
 * collide downwards, and each edge reads back its own offset.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Box = { id: string; x: number; y: number; w: number; h: number };

/** Breathing room between two labels that would otherwise touch. */
const GAP = 4;
/** Guards against a pathological cascade pushing a label off the canvas. */
const MAX_PASSES = 40;

const overlaps = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;

/**
 * Greedy vertical displacement, top-down.
 *
 * Sorting first makes the result stable: the same graph always resolves to the
 * same offsets, so labels do not jitter between renders.
 */
const resolve = (boxes: Map<string, Box>): Record<string, number> => {
  const sorted = Array.from(boxes.values()).sort(
    (a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id),
  );

  const placed: Box[] = [];
  const offsets: Record<string, number> = {};

  for (const box of sorted) {
    let dy = 0;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const moved = { ...box, y: box.y + dy };
      const hit = placed.find((p) => overlaps(p, moved));
      if (!hit) break;

      // Drop just below whatever it collided with.
      dy = hit.y + hit.h / 2 + GAP + box.h / 2 - box.y;
    }

    offsets[box.id] = dy;
    placed.push({ ...box, y: box.y + dy });
  }

  return offsets;
};

type Registry = {
  register: (id: string, box: Omit<Box, "id"> | null) => void;
  offsets: Record<string, number>;
};

const EdgeLabelContext = createContext<Registry>({
  register: () => {},
  offsets: {},
});

export const EdgeLabelProvider = ({ children }: { children: ReactNode }) => {
  const boxes = useRef(new Map<string, Box>());
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const frame = useRef<number | null>(null);

  // Coalesce into one pass per frame: a drag re-registers every label it moves.
  const schedule = useCallback(() => {
    if (frame.current !== null) return;

    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const next = resolve(boxes.current);

      setOffsets((prev) => {
        const keys = Object.keys(next);
        const same =
          keys.length === Object.keys(prev).length &&
          keys.every((k) => prev[k] === next[k]);
        // Returning the previous object stops a render loop: registering a
        // position triggers a resolve, which would otherwise re-render and
        // re-register forever.
        return same ? prev : next;
      });
    });
  }, []);

  const register = useCallback<Registry["register"]>(
    (id, box) => {
      if (!box) {
        if (boxes.current.delete(id)) schedule();
        return;
      }

      const prev = boxes.current.get(id);
      if (
        prev &&
        prev.x === box.x &&
        prev.y === box.y &&
        prev.w === box.w &&
        prev.h === box.h
      ) {
        return;
      }

      boxes.current.set(id, { id, ...box });
      schedule();
    },
    [schedule],
  );

  return (
    <EdgeLabelContext.Provider value={{ register, offsets }}>
      {children}
    </EdgeLabelContext.Provider>
  );
};

/**
 * Registers a label and returns how far down it should move to clear the
 * others, plus the ref to attach to the label element.
 *
 * The box is measured from the DOM rather than estimated from character count:
 * an estimate that is a few pixels short still leaves the labels overlapping,
 * which is the bug this exists to fix. `offsetWidth`/`offsetHeight` ignore the
 * viewport's zoom transform, so they are already in flow coordinates -- the
 * same space as `labelX`/`labelY`.
 */
export const useEdgeLabelOffset = (
  id: string,
  x: number,
  y: number,
  text: string | undefined,
) => {
  const { register, offsets } = useContext(EdgeLabelContext);
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!text || !el) {
      register(id, null);
      return;
    }

    register(id, { x, y, w: el.offsetWidth, h: el.offsetHeight });
  });

  // Drop the registration when the edge goes away, or its slot is held
  // forever and pushes later labels around for no reason.
  useEffect(() => () => register(id, null), [id, register]);

  return { dy: offsets[id] ?? 0, ref };
};
