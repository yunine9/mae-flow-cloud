export interface GitDiffSelection {
  selectedPaths: string[];
  committedPaths: string[];
  allPaths: string[];
}
export interface DeliverySelectionDraft { key: string; selection: GitDiffSelection | undefined }
/** A reading draft is scoped to one task/card. It never grants push permission. */
export function readDeliverySelectionDraft(raw: string | null, key: string): DeliverySelectionDraft | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (value.key !== key) return undefined;
    const selection = value.selection;
    if (!selection || ![selection.selectedPaths, selection.committedPaths, selection.allPaths]
      .every(paths => Array.isArray(paths) && paths.every(path => typeof path === "string"))) return undefined;
    return { key, selection };
  } catch { return undefined; }
}
