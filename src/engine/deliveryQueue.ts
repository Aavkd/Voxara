/**
 * Delivery Queue — the single channel for "things to tell the user outside
 * the request/response flow" (docs/phase-c1-reminders-continuity.md §3.3,
 * built in phase C2a because delegated-task completions are its first
 * producer; reminders join in C1).
 *
 * Records persist in ~/.llmtest/state/delivery.json. Consumers drain pending
 * records between text turns, at an idle voice boundary (C1), or at next
 * session startup. Missing/corrupted files degrade to empty.
 */

import * as fs from "fs";
import * as crypto from "crypto";
import { atomicWriteFileSync, ensureStateDir, getStatePaths } from "./statePaths";

export type DeliveryKind =
  | "reminder"
  | "task_result"
  | "task_failure"
  /** An external_action plan is ready and awaits explicit user approval (C2c §3.2). */
  | "task_approval";

export interface DeliveryRecord {
  id: string;
  kind: DeliveryKind;
  refId: string;
  text: string;
  queuedAt: string;
  deliveredAt: string | null;
}

/** Delivered records older than this are pruned on queue writes. */
const DELIVERED_RETENTION_DAYS = 30;

/** Read all delivery records; degrade to empty on any problem. */
export function listDeliveries(baseDir?: string): DeliveryRecord[] {
  const { deliveryFile } = getStatePaths(baseDir);
  if (!fs.existsSync(deliveryFile)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(deliveryFile, "utf-8"));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (d): d is DeliveryRecord =>
        !!d && typeof d.id === "string" && typeof d.text === "string"
    );
  } catch {
    return [];
  }
}

/** Queue a new delivery for the user. Returns the created record. */
export function queueDelivery(
  kind: DeliveryKind,
  refId: string,
  text: string,
  baseDir?: string
): DeliveryRecord {
  const record: DeliveryRecord = {
    id: `dlv-${crypto.randomBytes(4).toString("hex")}`,
    kind,
    refId,
    text,
    queuedAt: new Date().toISOString(),
    deliveredAt: null,
  };

  const deliveries = pruneOldDelivered(listDeliveries(baseDir));
  deliveries.push(record);
  writeDeliveries(deliveries, baseDir);
  return record;
}

/** Return pending (undelivered) records without marking them delivered. */
export function peekPendingDeliveries(baseDir?: string): DeliveryRecord[] {
  return listDeliveries(baseDir).filter((d) => d.deliveredAt === null);
}

/**
 * Return all pending deliveries and mark them delivered. The caller is
 * responsible for actually showing/speaking them after this returns.
 */
export function drainPendingDeliveries(baseDir?: string): DeliveryRecord[] {
  const deliveries = listDeliveries(baseDir);
  const pending = deliveries.filter((d) => d.deliveredAt === null);
  if (pending.length === 0) {
    return [];
  }

  const now = new Date().toISOString();
  for (const record of deliveries) {
    if (record.deliveredAt === null) {
      record.deliveredAt = now;
    }
  }
  writeDeliveries(pruneOldDelivered(deliveries), baseDir);
  return pending;
}

/**
 * Mark specific records delivered. Split from the peek so voice consumers can
 * confirm only after the announcement was actually spoken — a crash between
 * peek and mark re-queues the notification instead of losing it.
 */
export function markDeliveriesDelivered(ids: string[], baseDir?: string): void {
  if (ids.length === 0) {
    return;
  }
  const wanted = new Set(ids);
  const deliveries = listDeliveries(baseDir);
  const now = new Date().toISOString();
  let changed = false;
  for (const record of deliveries) {
    if (record.deliveredAt === null && wanted.has(record.id)) {
      record.deliveredAt = now;
      changed = true;
    }
  }
  if (changed) {
    writeDeliveries(pruneOldDelivered(deliveries), baseDir);
  }
}

function pruneOldDelivered(deliveries: DeliveryRecord[]): DeliveryRecord[] {
  const cutoff = Date.now() - DELIVERED_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return deliveries.filter((d) => {
    if (d.deliveredAt === null) {
      return true;
    }
    const t = Date.parse(d.deliveredAt);
    return Number.isNaN(t) || t >= cutoff;
  });
}

/** Atomic write: temp file then rename, with transient-error retry. */
function writeDeliveries(deliveries: DeliveryRecord[], baseDir?: string): void {
  const { deliveryFile } = ensureStateDir(baseDir);
  atomicWriteFileSync(deliveryFile, JSON.stringify(deliveries, null, 2));
}
