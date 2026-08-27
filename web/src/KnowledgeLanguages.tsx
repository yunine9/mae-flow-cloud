export const KNOWLEDGE_LANGUAGE_OPTIONS = [
  { id: "agnostic", label: "通用 / 语言无关" },
  { id: "java", label: "Java" },
  { id: "cpp", label: "C++" },
  { id: "c", label: "C" },
  { id: "csharp", label: "C#" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "python", label: "Python" },
  { id: "go", label: "Go" },
  { id: "rust", label: "Rust" },
  { id: "kotlin", label: "Kotlin" },
  { id: "groovy", label: "Groovy" },
  { id: "shell", label: "Shell" },
  { id: "sql", label: "SQL" },
] as const;

const LABELS = new Map<string, string>(
  KNOWLEDGE_LANGUAGE_OPTIONS.map((item) => [item.id, item.label]));

export function knowledgeLanguageLabel(id: string): string {
  return LABELS.get(id) ?? id;
}

export function KnowledgeLanguageTags({ languages, empty = "未标注语言" }: {
  languages: string[];
  empty?: string;
}) {
  if (!languages.length) {
    return <span className="knowledge-language-empty">{empty}</span>;
  }
  return <span className="knowledge-language-tags">
    {languages.map((id) => <em key={id}>{knowledgeLanguageLabel(id)}</em>)}
  </span>;
}

/** 语言只是工程语境，可多选；选择“语言无关”时自动清掉具体语言。 */
export function KnowledgeLanguagePicker({ value, onChange,
  includeAgnostic = true }: {
  value: string[];
  onChange: (value: string[]) => void;
  includeAgnostic?: boolean;
}) {
  const toggle = (id: string) => {
    if (value.includes(id)) {
      onChange(value.filter((item) => item !== id));
      return;
    }
    if (id === "agnostic") {
      onChange([id]);
      return;
    }
    onChange([...value.filter((item) => item !== "agnostic"), id]);
  };
  const options = !includeAgnostic
    ? KNOWLEDGE_LANGUAGE_OPTIONS.filter((item) => item.id !== "agnostic")
    : KNOWLEDGE_LANGUAGE_OPTIONS;
  return <div className="knowledge-language-picker"
    role="group" aria-label="适用语言，可多选">
    {options.map((option) => <button type="button"
      key={option.id} aria-pressed={value.includes(option.id)}
      onClick={() => toggle(option.id)}>{option.label}</button>)}
  </div>;
}

export function KnowledgeLanguageFilter({ value, onChange, counts }: {
  value: string;
  onChange: (value: string) => void;
  counts?: Map<string, number>;
}) {
  return <label className="knowledge-language-filter">
    <span>工程语境</span>
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="all">全部语言</option>
      <option value="untagged">未标注</option>
      {KNOWLEDGE_LANGUAGE_OPTIONS.map((option) => <option
        value={option.id} key={option.id}>{option.label}{
          counts?.has(option.id) ? `（${counts.get(option.id)}）` : ""}</option>)}
    </select>
  </label>;
}

export function matchesKnowledgeLanguage(
  languages: string[],
  filter: string,
): boolean {
  if (filter === "all") return true;
  if (filter === "untagged") return languages.length === 0;
  return languages.includes(filter);
}
