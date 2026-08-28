"use client";

/**
 * Crow's-foot markers for ER relationships.
 *
 * SVG markers are referenced by id across the whole document, so these are
 * defined once, hidden, and pointed at from edge `markerStart`/`markerEnd`.
 * `orient="auto-start-reverse"` lets the same shape serve both ends.
 */

export const MARKER_ARROW = "edge-arrow";
export const MARKER_ONE = "er-one";
export const MARKER_MANY = "er-many";

const STROKE = "#94a3b8";

export const ErMarkers = () => (
  <svg className="pointer-events-none absolute h-0 w-0" aria-hidden>
    <defs>
      {/* Plain arrowhead for flowchart / process connectors. */}
      <marker
        id={MARKER_ARROW}
        viewBox="0 0 12 12"
        markerWidth="12"
        markerHeight="12"
        refX="10"
        refY="6"
        orient="auto-start-reverse"
        markerUnits="userSpaceOnUse"
      >
        <path d="M2,1.5 L10,6 L2,10.5 Z" fill={STROKE} />
      </marker>

      {/* "exactly one" -- a single perpendicular tick across the line */}
      <marker
        id={MARKER_ONE}
        viewBox="0 0 16 20"
        markerWidth="16"
        markerHeight="20"
        refX="14"
        refY="10"
        orient="auto-start-reverse"
        markerUnits="userSpaceOnUse"
      >
        <path
          d="M10,3 L10,17"
          fill="none"
          stroke={STROKE}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </marker>

      {/* "many" -- the three-pronged foot, opening back along the line */}
      <marker
        id={MARKER_MANY}
        viewBox="0 0 16 20"
        markerWidth="16"
        markerHeight="20"
        refX="14"
        refY="10"
        orient="auto-start-reverse"
        markerUnits="userSpaceOnUse"
      >
        {/* Prongs spread wide enough that the foot does not read as a plain
            arrowhead at normal zoom. */}
        <path
          d="M14,10 L3,1 M14,10 L3,10 M14,10 L3,19"
          fill="none"
          stroke={STROKE}
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </marker>
    </defs>
  </svg>
);
