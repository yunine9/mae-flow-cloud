import { useState } from "react";
import { mrParticipantsMessage, type MrParticipantsResult } from "../../src/mrParticipants";
import { Button } from "./components/ui/button";

export function MrParticipantsNotice({ result, endpoint, body, canRetry, onChanged }: {
  result?: MrParticipantsResult;
  endpoint: string;
  body?: Record<string, string>;
  canRetry?: boolean;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState<MrParticipantsResult>();
  const shown = updated && result?.status === "failed" ? updated : result;
  if (!shown) return null;
  async function retry() {
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
      const next = value.delivery?.mr_participants
        ?? value.mrs?.find((mr: { repo: string }) => mr.repo === body?.repo)?.participants;
      if (next) setUpdated(next);
      onChanged?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="grid gap-2 text-sm" role={shown.status === "failed" ? "alert" : "status"}>
    <p className={shown.status === "failed" ? "m-0 text-attention" : "m-0 text-muted-foreground"}>{mrParticipantsMessage(shown)}</p>
    {shown.status === "failed" && canRetry && <Button type="button" variant="outline" size="sm"
      className="w-fit" disabled={busy} onClick={() => void retry()}>{busy ? "正在设置人员…" : "重试设置人员"}</Button>}
    {error && <p className="m-0 text-danger">{error}</p>}
  </div>;
}
