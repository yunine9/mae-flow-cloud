import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSafeWorktreeGitAsync } from "./safeGit.ts";
import { analyticsCodePath, analyticsGit } from "./deliveryAnalyticsGit.ts";
import { redactAnalysisText, restrictedAnalysisPathSegment } from "./analysisText.ts";
import type { MrComparison, MrComparisonDetail } from "./deliveryAnalyticsTypes.ts";

export interface ComparisonVersions { initial: { head?: string; base?: string }; final: { head?: string; base?: string } }
const sha = /^(?:[\da-f]{40}|[\da-f]{64})$/;
const maxFiles = 300, maxLines = 100_000, maxPatchChars = 8_000, maxAllPatchChars = 160_000;

// Strip coordinates and baseline context that shift during a rebase. Preserve
// edit order, signs and Git's function labels, including repeated lines.
function patchChanges(diff: string): string {
  const changes: string[] = [];
  let hunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@ ")) { hunk = true; changes.push(line.slice(line.indexOf(" @@", 3) + 1)); }
    else if (hunk && (line[0] === "+" || line[0] === "-" || line.startsWith("\\ No newline"))) changes.push(line);
    else if (!hunk && /^(?:old mode|new mode) /.test(line)) changes.push(line);
  }
  return changes.length ? changes.join("\n") + "\n" : "";
}

async function diffChanges(cwd: string, first: string, final: string) {
  if (first === final) return "";
  const root = await mkdtemp(join(tmpdir(), "mfc-mr-diff-"));
  try {
    const a = join(root, "initial"), b = join(root, "final");
    await Promise.all([writeFile(a, first), writeFile(b, final)]);
    const diff = await runSafeWorktreeGitAsync(cwd, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=2", "--", a, b], { timeoutMs: 15_000, maxBuffer: 16 * 1024 * 1024 });
    if (diff.status !== 1) throw new Error("无法读取两份 MR 的修改行差异");
    const hunk = diff.stdout.indexOf("\n@@ ");
    if (hunk < 0) throw new Error("两份补丁缺少可读文本差异");
    return diff.stdout.slice(hunk + 1);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** Compare each MR against its own diff base. Equal signed lines at the same path
 * are counted up to their multiplicity; this describes content, not authorship. */
export async function compareFinalMr(cwd: string, versions: ComparisonVersions): Promise<{ summary: MrComparison; detail: MrComparisonDetail }> {
  const { initial, final } = versions;
  const before = initial.head, after = final.head;
  if (!before || !after || !initial.base || !final.base || ![before, after, initial.base, final.base].every(v => sha.test(v))) {
    throw new Error("缺少初版或最终 MR 的源版本、比较基线，无法比较代码");
  }
  const started = Date.now();
  const run = (args: string[]) => {
    if (Date.now() - started > 60_000) throw new Error("比较超过一分钟，未返回不完整的统计");
    return analyticsGit(cwd, args);
  };
  for (const [base, head] of [[initial.base, before], [final.base, after]]) {
    await run(["merge-base", "--is-ancestor", base, head]);
  }
  let method: "ancestry" | "patch" = "ancestry";
  if (before !== after) {
    // A single merge-base can be ambiguous in criss-cross histories; ancestry of
    // the pinned initial commit is unambiguous when it is the only merge base.
    const bases = await run(["merge-base", "--all", before, after]).catch(() => "");
    method = bases.trim() === before ? "ancestry" : "patch";
  }
  const changedPaths = async (base: string, head: string) => {
    const numstat = await run(["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, head, "--"]);
    return new Set(numstat.split("\0").flatMap(field => {
      const entry = /^\d+\t\d+\t([\s\S]+)$/.exec(field);
      return entry && analyticsCodePath(entry[1]) && !entry[1].split(/[\\/]/).some(s => restrictedAnalysisPathSegment.test(s)) ? [entry[1]] : [];
    }));
  };
  const originalPaths = await changedPaths(initial.base, before), finalPaths = await changedPaths(final.base, after);
  const paths = [...new Set([...originalPaths, ...finalPaths])].sort();
  if (paths.length > maxFiles) throw new Error("比较涉及超过 300 个代码文件，无法提供完整统计");
  const sameBase = initial.base === final.base;
  const files: NonNullable<MrComparison["files"]> = [], detail: MrComparisonDetail = { comparison_basis: sameBase ? "head" : "patch", files: [], truncated: false };
  let retained = 0, removed = 0, added = 0, lines = 0, remaining = maxAllPatchChars;
  for (const path of paths) {
    const patch = (base: string, head: string) => run(["--literal-pathspecs", "diff", "--unified=2", "--no-color", "--no-renames", "--no-ext-diff", "--no-textconv", base, head, "--", path]);
    const first = originalPaths.has(path) ? await patch(initial.base, before) : "";
    const last = finalPaths.has(path) ? await patch(final.base, after) : "";
    const signed = (diff: string) => {
      const counts = new Map<string, number>();
      let inHunk = false, total = 0;
      for (const line of diff.split("\n")) {
        if (line.startsWith("@@ ")) inHunk = true;
        else if (inHunk && (line[0] === "+" || line[0] === "-")) {
          if (++lines > maxLines) throw new Error("代码变更超过十万行，无法提供完整统计");
          counts.set(line, (counts.get(line) ?? 0) + 1);
          total++;
        }
      }
      return { counts, total };
    };
    const a = signed(first), b = signed(last);
    let same = 0;
    for (const [line, count] of a.counts) same += Math.min(count, b.counts.get(line) ?? 0);
    const change = sameBase ? await patch(before, after) : await diffChanges(cwd, patchChanges(first), patchChanges(last));
    files.push({ path, changed: !!change, retained: same, removed: a.total - same, added: b.total - same });
    retained += same; removed += a.total - same; added += b.total - same;
    if (!change) continue;
    if (remaining <= 0) { detail.truncated = true; continue; }
    const [changeText, initialText, finalText] = [change, first, last].map(redactAnalysisText);
    const take = (text: string) => {
      const result = text.slice(0, Math.min(remaining, maxPatchChars));
      remaining -= result.length;
      return result;
    };
    const change_patch = take(changeText), initial_patch = take(initialText), final_patch = take(finalText);
    const truncated = change_patch.length !== changeText.length || initial_patch.length !== initialText.length || final_patch.length !== finalText.length;
    detail.truncated ||= truncated;
    detail.files.push({ path, change_patch, initial_patch, final_patch, truncated });
  }
  files.sort((a, b) => Number(b.changed) - Number(a.changed));
  return { summary: { method, initial_head: before, final_head: after, retained, removed, added, files }, detail };
}
