/** Append-only Cloud index over the source-specific review ledgers. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
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

export class FeedbackStoreCorruptionError extends Error {}

export class FeedbackStore {
  constructor(readonly path: string) {}

  list(): FeedbackRecord[] {
    if (!existsSync(this.path)) return [];
    const records = new Map<string, FeedbackRecord>();
    const text = readFileSync(this.path, "utf-8");
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
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
        } else {
          throw new Error("未知操作或缺少反馈标识");
        }
      } catch (error) {
        const truncatedTail = index === lines.length - 1 && !text.endsWith("\n");
        if (truncatedTail) break;
        throw new FeedbackStoreCorruptionError(
          `持续检视索引第 ${index + 1} 行损坏，已停止读写，不能静默隐藏反馈：${String(error)}`,
        );
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
    this.repairTruncatedTail();
    writeFileSync(this.path, JSON.stringify(operation) + "\n", {
      encoding: "utf-8", mode: 0o600, flag: "a",
    });
  }

  /** A crash may leave only the final JSON line torn.  Trim that suffix before
   * appending; any corrupt complete/middle line remains a fail-closed error. */
  private repairTruncatedTail(): void {
    if (!existsSync(this.path)) return;
    const text = readFileSync(this.path, "utf-8");
    if (!text || text.endsWith("\n")) {
      // list() performs the strict middle-line validation.
      this.list();
      return;
    }
    const lastBreak = text.lastIndexOf("\n");
    const tail = text.slice(lastBreak + 1);
    try {
      JSON.parse(tail);
      // A complete final record missing only its newline is preserved.
      writeFileSync(this.path, "\n", { encoding: "utf-8", flag: "a" });
    } catch {
      truncateSync(this.path, lastBreak < 0 ? 0
        : Buffer.byteLength(text.slice(0, lastBreak + 1), "utf-8"));
    }
    this.list();
  }
}
