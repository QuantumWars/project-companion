/**
 * Decision cards and weekly updates (devolps TR-14, PC-01, PC-06).
 *
 * A decision card is a question for the PM that is not a gate: which email
 * provider, which track a piece of work takes. A weekly update is the PM's
 * status report, drafted by an agent and published by the PM.
 *
 * Both are events, folded into state like everything else in the log. Answering
 * a card and publishing an update are the PM's acts, so both carry `via` --
 * how the decision arrived -- and devolps reconciles it against the commands
 * the PM typed, exactly as it does for gates.
 */

import type { ProjectEvent } from "./events";

export type CardKind = "question" | "track";

export type Card = {
  id: string;
  kind: CardKind;
  /** The epic, task or sprint it is about. */
  subject: string;
  ask: string;
  why?: string;
  options: string[];
  recommendation?: string;
  costOfWaiting?: string;
  /** ISO date. */
  deadline?: string;
  openedAt: number;
  answer?: string;
  answeredAt?: number;
  via?: string;
};

export const foldCards = (events: readonly ProjectEvent[]): Map<string, Card> => {
  const cards = new Map<string, Card>();
  for (const e of events) {
    const d = e.data ?? {};
    const id = typeof d.cardId === "string" ? d.cardId : undefined;
    if (!id) continue;
    if (e.kind === "card.opened" && !cards.has(id)) {
      cards.set(id, {
        id,
        kind: d.kind === "track" ? "track" : "question",
        subject: String(d.subject ?? ""),
        ask: String(d.ask ?? ""),
        why: typeof d.why === "string" ? d.why : undefined,
        options: Array.isArray(d.options) ? d.options.map(String) : [],
        recommendation: typeof d.recommendation === "string" ? d.recommendation : undefined,
        costOfWaiting: typeof d.costOfWaiting === "string" ? d.costOfWaiting : undefined,
        deadline: typeof d.deadline === "string" ? d.deadline : undefined,
        openedAt: e.ts,
      });
    } else if (e.kind === "card.answered") {
      const card = cards.get(id);
      if (!card || card.answer !== undefined) continue; // The first answer stands.
      card.answer = String(d.answer ?? "");
      card.answeredAt = e.ts;
      card.via = typeof d.via === "string" ? d.via : undefined;
    }
  }
  return cards;
};

export const HEALTH = ["on-track", "at-risk", "off-track"] as const;
export type Health = (typeof HEALTH)[number];
export const isHealth = (v: string): v is Health => (HEALTH as readonly string[]).includes(v);

export type WeeklyUpdate = {
  id: string;
  /** The epic it covers; absent for a project-wide update. */
  epic?: string;
  health: Health;
  reason: string;
  body: string;
  draftedAt: number;
  publishedAt?: number;
  via?: string;
};

/** A re-draft before publishing replaces the draft; a published update is final. */
export const foldUpdates = (events: readonly ProjectEvent[]): Map<string, WeeklyUpdate> => {
  const updates = new Map<string, WeeklyUpdate>();
  for (const e of events) {
    const d = e.data ?? {};
    const id = typeof d.updateId === "string" ? d.updateId : undefined;
    if (!id) continue;
    if (e.kind === "update.drafted") {
      if (updates.get(id)?.publishedAt) continue;
      const health = String(d.health ?? "");
      updates.set(id, {
        id,
        epic: typeof d.epic === "string" ? d.epic : undefined,
        health: isHealth(health) ? health : "at-risk",
        reason: String(d.reason ?? ""),
        body: String(d.body ?? ""),
        draftedAt: e.ts,
      });
    } else if (e.kind === "update.published") {
      const u = updates.get(id);
      if (!u || u.publishedAt) continue;
      u.publishedAt = e.ts;
      u.via = typeof d.via === "string" ? d.via : undefined;
    }
  }
  return updates;
};

/** ISO week id, e.g. `2026-w41`, for naming weekly updates. */
export const weekId = (ts: number): string => {
  const date = new Date(ts);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-w${String(week).padStart(2, "0")}`;
};

/**
 * Monday-to-Friday days between two instants, in local time (PC-02.2).
 * Counts whole days elapsed, so a card opened this morning is 0 days old.
 */
export const workingDaysBetween = (from: number, to: number): number => {
  if (to <= from) return 0;
  let days = 0;
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) days++;
  }
  return days;
};
