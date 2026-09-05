/**
 * Turning a coding agent's hooks into run events.
 *
 * Claude Code fires a hook on session start, after every tool use, and when a
 * session ends. Each one arrives as JSON on stdin. That is enough to know what
 * an agent actually did without asking it to report, which matters because a
 * report is a claim and a hook is a record.
 *
 * ---- why the field names look like OpenTelemetry ----
 *
 * The payload is normalised onto the GenAI semantic conventions --
 * `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `execute_tool` -- rather
 * than onto Claude Code's own shape. Codex, Cursor, a CI job or a harness that
 * does not exist yet can then emit the same JSON with no adapter here, and the
 * hook script stays the only Claude-specific part.
 *
 * ---- what it does with a payload it does not understand ----
 *
 * Nothing, quietly. A hook that fails is a hook that breaks somebody's coding
 * session, so an unrecognised event is not an error -- it is an event this
 * build has no opinion about yet.
 */

export type HookEvent =
  | { kind: "session.start"; sessionId: string; model?: string; harness?: string }
  | {
      kind: "tool.use";
      sessionId: string;
      tool?: string;
      inputTokens?: number;
      outputTokens?: number;
      touched: string[];
    }
  | { kind: "session.end"; sessionId: string; reason?: string }
  | { kind: "unknown" };

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Tools whose input names a file the agent wrote. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

/**
 * Pulls the paths a tool call actually wrote.
 *
 * Reads are deliberately not counted. A run's `touched` list feeds the review
 * packet and the attestation, and padding it with every file the agent glanced
 * at would bury the handful it changed.
 */
const writtenPaths = (payload: Record<string, unknown>): string[] => {
  const tool = str(payload.tool_name) ?? str(payload.tool);
  if (!tool || !WRITE_TOOLS.has(tool)) return [];

  const input = typeof payload.tool_input === "object" && payload.tool_input !== null
    ? (payload.tool_input as Record<string, unknown>)
    : {};

  const single = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  if (single) return [single];

  // `MultiEdit` and patch-shaped tools carry several.
  const edits = Array.isArray(input.edits) ? input.edits : [];
  return edits
    .map((edit) => (typeof edit === "object" && edit !== null ? str((edit as Record<string, unknown>).file_path) : undefined))
    .filter((p): p is string => Boolean(p));
};

/**
 * Normalises one hook payload.
 *
 * Both spellings are accepted for every field: the OTel one, which other
 * harnesses will send, and Claude Code's own, which is what actually arrives
 * today. Preferring OTel means a harness that adopts the convention needs no
 * change here.
 */
export const parseHook = (raw: unknown): HookEvent => {
  if (typeof raw !== "object" || raw === null) return { kind: "unknown" };
  const payload = raw as Record<string, unknown>;

  const sessionId =
    str(payload["gen_ai.conversation.id"]) ?? str(payload.session_id) ?? str(payload.sessionId);
  if (!sessionId) return { kind: "unknown" };

  const event = str(payload.hook_event_name) ?? str(payload.event);

  if (event === "SessionStart" || event === "invoke_agent") {
    return {
      kind: "session.start",
      sessionId,
      model: str(payload["gen_ai.request.model"]) ?? str(payload.model),
      harness: str(payload["gen_ai.system"]) ?? "claude-code",
    };
  }

  if (event === "PostToolUse" || event === "execute_tool") {
    return {
      kind: "tool.use",
      sessionId,
      tool: str(payload["gen_ai.tool.name"]) ?? str(payload.tool_name),
      inputTokens: num(payload["gen_ai.usage.input_tokens"]) ?? num(payload.input_tokens),
      outputTokens: num(payload["gen_ai.usage.output_tokens"]) ?? num(payload.output_tokens),
      touched: writtenPaths(payload),
    };
  }

  if (event === "SessionEnd" || event === "Stop") {
    return { kind: "session.end", sessionId, reason: str(payload.reason) };
  }

  return { kind: "unknown" };
};
