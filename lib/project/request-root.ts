import { findProjectRoot } from "./store";
import { isKnownProject } from "./registry";

export type RootResult =
  | { ok: true; root: string }
  | { ok: false; status: number; error: string };

/**
 * Resolves which project a request is about.
 *
 * Defaults to the project the app is running inside. A `?root=` may name a
 * different one, but only if it is in the global index -- otherwise the query
 * string would be a way to read any directory the server can reach.
 */
export const resolveRequestRoot = (request: Request): RootResult => {
  const asked = new URL(request.url).searchParams.get("root");

  if (asked) {
    if (!isKnownProject(asked)) {
      return {
        ok: false,
        status: 403,
        error: "Unknown project. Only indexed projects can be opened.",
      };
    }
    return { ok: true, root: asked };
  }

  const here = findProjectRoot();
  if (!here) {
    return { ok: false, status: 404, error: "No project store found" };
  }

  return { ok: true, root: here };
};
