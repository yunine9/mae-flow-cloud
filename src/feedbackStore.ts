/** Append-only Cloud index over the source-specific review ledgers. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type FeedbackSource =
  | "workspace"
  | "build_fix"
  | "pipeline"
  | "mr_discussion"
  | "conflict"
  | "scope"
  | "push_confirmation";

export type FeedbackStatus =
  | "open"
  | "repairing"
  | "addressed"
  | "awaiting_verification"
  | "closed"
  | "needs_human";

export interface FeedbackRecord {
  id: string;
  batch_id: string;
  source: FeedbackSource;
  source_id: string;
  source_revision: number;
  observed_sha: string;
  summary: string;
  material?: string;
  file?: string;
  line?: number;
  verification: string;
  status: FeedbackStatus;
  resolution?: string;
  updated_at: string;
}

type Operation =
  | { op: "upsert"; record: FeedbackRecord }
  | { op: "resolve"; id: string; status: FeedbackStatus;
      resolution: string; at: string };

export class FeedbackStore {
  constructor(readonly path: string) {}

  list(): FeedbackRecord[] {
    if (!existsSync(this.path)) return [];
    const records = new Map<string, FeedbackRecord>();
    for (const line of readFileSync(this.path, "utf-8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const operation = JSON.parse(line) as Operation;
        if (operation.op === "upsert" && operation.record?.id) {
          records.set(operation.record.id, operation.record);
        } else if (operation.op === "resolve") {
          const previous = records.get(operation.id);
          if (previous) records.set(operation.id, {
            ...previous,
            status: operation.status,
            resolution: operation.resolution,
            updated_at: operation.at,
          });
        }
      } catch {
        // Read-side corruption is named by diagnostics elsewhere; one bad line
        // must not hide the remaining feedback from the user.
      }
    }
    return [...records.values()].sort((a, b) =>
      a.updated_at.localeCompare(b.updated_at));
  }

  upsert(records: FeedbackRecord[]): void {
    const current = new Map(this.list().map((record) => [record.id, record]));
    for (const record of records) {
      const previous = current.get(record.id);
      if (previous && previous.batch_id === record.batch_id) continue;
      this.append({ op: "upsert", record });
    }
  }

  resolve(
    id: string,
    status: FeedbackStatus,
    resolution: string,
  ): void {
    this.append({
      op: "resolve", id, status, resolution,
      at: new Date().toISOString(),
    });
  }

  private append(operation: Operation): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(operation) + "\n", {
      encoding: "utf-8", mode: 0o600, flag: "a",
    });
  }
}
