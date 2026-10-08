import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import { resolveRequestRoot } from "@/lib/project/request-root";
import { LOG_DIR } from "@/lib/project/events";
import { BUNDLE_FILE } from "@/lib/project/bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tells the browser when something changed, instead of being asked every four
 * seconds whether it did.
 *
 * The app polled three separate endpoints on a timer, and the board, the git
 * surface and the launcher did not refresh at all -- so an agent creating a
 * diagram was invisible until you navigated. Polling was the right first
 * answer: it is trivial and it works. It is the wrong second answer, because
 * the interval is simultaneously too slow to feel live and too fast to be free.
 *
 * ---- what it watches, and why not everything ----
 *
 * Five paths, each standing for a kind of change the UI reacts to differently.
 * A recursive watch over the repository would also fire for every file the
 * developer edits, every build artefact and every `node_modules` write, which
 * is thousands of events to deliver the handful that matter.
 *
 * ---- what it deliberately does not send ----
 *
 * The change itself. This says only which kind of thing moved; the client
 * re-reads whatever it needs. Sending the data would mean serialising the
 * project on every keystroke of an agent's edit, and would put a second copy of
 * every read path in here to go stale against the first.
 */

type Signal = "project" | "log" | "prd" | "git";

const WATCHED: { path: string; signal: Signal; directory?: boolean }[] = [
  { path: BUNDLE_FILE, signal: "project" },
  { path: LOG_DIR, signal: "log", directory: true },
  { path: "docs", signal: "prd", directory: true },
  { path: join(".git", "HEAD"), signal: "git" },
  { path: join(".git", "refs"), signal: "git", directory: true },
];

/** Writes are temp-file-then-rename, so one save is several filesystem events. */
const QUIET_MS = 120;

/** Long enough that an idle tab is cheap; short enough to hold a proxy open. */
const HEARTBEAT_MS = 25_000;

export const GET = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return new Response("event: closed\ndata: {}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  const root = resolved.root;
  const watchers: FSWatcher[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const pending = new Set<Signal>();
      let quiet: ReturnType<typeof setTimeout> | undefined;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const flush = () => {
        if (!pending.size) return;
        send("changed", { signals: Array.from(pending) });
        pending.clear();
      };

      const note = (signal: Signal) => {
        pending.add(signal);
        clearTimeout(quiet);
        quiet = setTimeout(flush, QUIET_MS);
      };

      for (const target of WATCHED) {
        try {
          // A path that does not exist yet is not an error: a project with no
          // `docs/` is a project whose PRD has not been created, and watching
          // its parent to notice would fire for everything else in the tree.
          watchers.push(watch(join(root, target.path), { persistent: false }, () => note(target.signal)));
        } catch {
          // Nothing to watch there; the client's fallback poll still covers it.
        }
      }

      // Told immediately, so a client can distinguish "connected and quiet"
      // from "never connected" and decide whether to keep polling.
      send("open", { watching: watchers.length });
      heartbeat = setInterval(() => send("ping", {}), HEARTBEAT_MS);

      request.signal.addEventListener("abort", () => {
        closed = true;
        clearTimeout(quiet);
        if (heartbeat) clearInterval(heartbeat);
        for (const watcher of watchers) watcher.close();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      for (const watcher of watchers) watcher.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and friends buffer by default, which turns a stream into a file
      // that arrives when the connection ends.
      "x-accel-buffering": "no",
    },
  });
};
