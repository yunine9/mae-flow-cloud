/**
 * 流水线红灯维度与“可供修复的具体证据”对齐。
 *
 * status 只说明 COMPILE / UT / CODECHECK 哪一维红；artifacts 才回答
 * 为什么红。两者必须逐维度对齐，不能用“整个材料包非空”替代。
 * 这里是纯判定层，不推进任务、不调用外部系统，方便拿内网真实样例回归。
 */
import type {
  PipelineCheck,
  PipelineDimension,
} from "./pipelineContract.ts";

export interface PipelineArtifactText {
  name: string;
  text: string;
}

export interface PipelineEvidenceAssessment {
  failedDimensions: PipelineDimension[];
  availableDimensions: PipelineDimension[];
  missingDimensions: PipelineDimension[];
  sources: Partial<Record<PipelineDimension, string[]>>;
  reasons: Partial<Record<PipelineDimension, string[]>>;
}

export const PIPELINE_DIMENSION_TEXT: Record<PipelineDimension, string> = {
  COMPILE: "编译/构建",
  UT: "UT/覆盖率",
  CODECHECK: "CodeCheck",
};

const NO_DATA = /^(?:no data(?: found)?|not found|empty|null|undefined)$/i;
const COMPILE_ERROR = /(?:fatal error|\berror:|undefined reference|collect2:|ld(?:\.lld)?: error|make(?:\[\d+\])?: \*\*\*|\[ERROR\]|killed signal|compilation failure|build failure)/i;
const UT_ERROR = /(?:tests? (?:run:.*)?fail(?:ed|ure)?|failures?!!!|assert(?:ion)?(?:error| failed)|expected .+ (?:but|to)|unit tests? failed|coverage.+(?:below|less|failed)|\bFAILED\b.+(?:test|case)|\bCPP_UT\b)/i;
const PATH_WITH_LINE = /(?:[A-Za-z]:)?[^\s"']+\.(?:c|cc|cpp|cxx|h|hpp|java|kt|py|js|jsx|ts|tsx|go|rs|cs|xml):\d+/i;

const TOOL_DIMENSIONS: Array<[RegExp, PipelineDimension]> = [
  [/^(?:cloudbuild2\.0|build2\.0)$/i, "COMPILE"],
  [/^(?:cpp_ut|ut|unit[_-]?test|coverage)$/i, "UT"],
  [/^(?:codecheck|codecheckfortest|codechecktest|superchecker|codeccp)/i,
    "CODECHECK"],
];

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function meaningful(text: string): boolean {
  const value = text.trim();
  return !!value && !NO_DATA.test(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function dimensionOfTool(tool: unknown): PipelineDimension | undefined {
  const name = String(tool ?? "").trim();
  return TOOL_DIMENSIONS.find(([pattern]) => pattern.test(name))?.[1];
}

/** 找 JSON 里真正可定位的一条缺陷，而不是“defectCount=3”这类汇总。 */
function hasLocatedDefect(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasLocatedDefect);
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const entries = Object.entries(row);
  const field = entries.find(([key, current]) =>
    /^(?:file|file_?path|filename|relative_?path|path)$/i.test(key)
      && meaningful(String(current ?? "")));
  const line = entries.find(([key, current]) =>
    /^(?:line|line_?(?:no|num|number)|lineno|linenum|start_?line|new_?line)$/i
      .test(key)
      && Number.isFinite(Number(current)) && Number(current) > 0);
  const diagnosis = entries.find(([key, current]) =>
    /^(?:message|msg|description|detail|rule|rule_?(?:id|name)|indicator_?name|checker_?name|error)$/i
      .test(key) && meaningful(String(current ?? "")));
  if (field && line && diagnosis) return true;
  return entries.some(([, nested]) => hasLocatedDefect(nested));
}

function actionableCodecheck(text: string): boolean {
  if (!meaningful(text)) return false;
  const parsed = parseJson(text);
  if (parsed !== undefined && hasLocatedDefect(parsed)) return true;
  return PATH_WITH_LINE.test(text)
    && /(?:rule|codecheck|checker|severity|缺陷|[A-Z](?:\.[A-Z0-9_-]+){2,})/i
      .test(text);
}

function actionableStructuredError(text: string): boolean {
  if (!meaningful(text)) return false;
  const parsed = parseJson(text);
  if (parsed !== undefined && hasLocatedDefect(parsed)) return true;
  return COMPILE_ERROR.test(text) || UT_ERROR.test(text)
    || PATH_WITH_LINE.test(text);
}

function pipelineInfoRecordDimensions(
  artifacts: PipelineArtifactText[],
): Map<string, PipelineDimension> {
  const info = artifacts.find((item) => item.name === "pipeline_info.json");
  const parsed = info ? parseJson(info.text) : undefined;
  const rows = parsed && typeof parsed === "object"
    && Array.isArray((parsed as Record<string, unknown>).defects)
    ? (parsed as { defects: unknown[] }).defects : [];
  const mapped = new Map<string, PipelineDimension>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const dimension = dimensionOfTool(row.toolName ?? row.tool_name ?? row.tool);
    if (!dimension) continue;
    const recordIds = Array.isArray(row.record_ids)
      ? row.record_ids : Array.isArray(row.recordIds) ? row.recordIds : [];
    for (const record of recordIds) {
      const id = String(record ?? "").trim();
      if (id) mapped.set(id, dimension);
    }
  }
  return mapped;
}

function summaryReasons(
  artifacts: PipelineArtifactText[],
): Partial<Record<PipelineDimension, string[]>> {
  const item = artifacts.find((entry) =>
    entry.name === "pipeline_log_summary.json");
  const parsed = item ? parseJson(item.text) : undefined;
  const strategies = parsed && typeof parsed === "object"
    ? (parsed as Record<string, any>).strategies : undefined;
  const note = (name: string): string | undefined => {
    const row = strategies?.[name];
    if (!row || row.status !== "failed") return undefined;
    const text = String(row.note ?? `${name} 未拿到证据`).trim();
    return text || `${name} 未拿到证据`;
  };
  return {
    COMPILE: unique([note("build-logs")].filter(Boolean) as string[]),
    UT: unique([note("build-logs"), note("coverage")]
      .filter(Boolean) as string[]),
    CODECHECK: unique([note("codecheck")].filter(Boolean) as string[]),
  };
}

function addSource(
  sources: Partial<Record<PipelineDimension, string[]>>,
  dimension: PipelineDimension,
  source: string,
): void {
  (sources[dimension] ??= []).push(source);
}

/**
 * 人工回灌只对当时明确缺失的维度背书；普通批注不会被自动扩大解释。
 */
export function assessPipelineRepairEvidence(input: {
  checks: PipelineCheck[] | undefined;
  artifacts: PipelineArtifactText[];
  /** status 接口随终态直接返回的失败摘要；它也必须按内容逐维归类，
   * 不能因为非空就给所有红灯维度背书。 */
  failureSummary?: string;
  humanEvidence?: { dimensions: PipelineDimension[]; text: string };
}): PipelineEvidenceAssessment {
  const failedDimensions = unique((input.checks ?? [])
    .filter((check) => check.status === "failed")
    .map((check) => check.dimension));
  const sources: Partial<Record<PipelineDimension, string[]>> = {};
  const recordDimensions = pipelineInfoRecordDimensions(input.artifacts);

  const summary = input.failureSummary?.trim() ?? "";
  if (meaningful(summary)) {
    if (failedDimensions.includes("COMPILE") && COMPILE_ERROR.test(summary)) {
      addSource(sources, "COMPILE", "流水线终态失败摘要");
    }
    if (failedDimensions.includes("UT") && UT_ERROR.test(summary)) {
      addSource(sources, "UT", "流水线终态失败摘要");
    }
    if (failedDimensions.includes("CODECHECK")
        && actionableCodecheck(summary)) {
      addSource(sources, "CODECHECK", "流水线终态失败摘要");
    }
  }

  for (const check of input.checks ?? []) {
    if (check.status !== "failed" || !check.details?.length) continue;
    if (check.dimension === "CODECHECK") {
      if (check.details.some((detail) =>
        !!detail.file && !!detail.line && meaningful(detail.message))) {
        addSource(sources, "CODECHECK", "status checks 的文件/行号缺陷明细");
      }
      continue;
    }
    if (check.details.some((detail) => meaningful(detail.message)
      && (!!detail.file || !!detail.rule || !!detail.line))) {
      addSource(sources, check.dimension, "status checks 的结构化失败明细");
    }
  }

  for (const artifact of input.artifacts) {
    const { name, text } = artifact;
    if (name === "codecheck_detail.json" && actionableCodecheck(text)) {
      addSource(sources, "CODECHECK", name);
      continue;
    }
    if (/^coverage_diff_.+\.json$/i.test(name)
        && meaningful(text) && !/no data(?: found)?/i.test(text)) {
      addSource(sources, "UT", name);
      continue;
    }
    const build = /^(?:build_log_|build_errors_|build_error_excerpt_)(.+)\.(?:txt|json)$/i
      .exec(name);
    if (!build) continue;
    const recordId = build[1];
    const mapped = [...recordDimensions.entries()].find(([id]) =>
      recordId === id || name.includes(id))?.[1];
    const dimension = mapped ?? "COMPILE";
    const actionable = name.startsWith("build_error_excerpt_")
      ? (dimension === "UT" ? UT_ERROR.test(text)
        : actionableStructuredError(text))
      : name.startsWith("build_errors_")
        ? actionableStructuredError(text)
        : dimension === "UT" ? UT_ERROR.test(text) : COMPILE_ERROR.test(text);
    if (actionable) addSource(sources, dimension, name);
  }

  if (input.humanEvidence?.dimensions.length
      && meaningful(input.humanEvidence.text)) {
    for (const dimension of input.humanEvidence.dimensions) {
      addSource(sources, dimension, "工作台人工批注回灌");
    }
  }

  for (const dimension of Object.keys(sources) as PipelineDimension[]) {
    sources[dimension] = unique(sources[dimension] ?? []);
  }
  const availableDimensions = failedDimensions.filter((dimension) =>
    (sources[dimension]?.length ?? 0) > 0);
  const missingDimensions = failedDimensions.filter((dimension) =>
    !availableDimensions.includes(dimension));
  const reasons = summaryReasons(input.artifacts);
  for (const dimension of missingDimensions) {
    const existing = reasons[dimension] ?? [];
    if (!existing.length) existing.push(
      `${PIPELINE_DIMENSION_TEXT[dimension]} 红灯，但没有可定位的具体报错`);
    reasons[dimension] = unique(existing);
  }
  return {
    failedDimensions,
    availableDimensions,
    missingDimensions,
    sources,
    reasons,
  };
}
