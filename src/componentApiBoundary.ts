import { readFileSync } from "node:fs";
/** Compatibility export; research sessions use the pinned Skill package. */
export const COMPONENT_API_BOUNDARY = readFileSync(new URL("../internal-skills/component-knowledge-extraction/references/api-boundary.md", import.meta.url), "utf8").trimEnd();
