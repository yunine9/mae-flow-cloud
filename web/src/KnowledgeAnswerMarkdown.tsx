import { Markdown } from "./markdown";

/** 来源原句和标签已按固定规则转义；只还原这一层，再交给 React 当文字显示。 */
function sourceText(row: string): string {
  return row.replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function sourceLinkLabel(label: string, href: string): string {
  return /^#evidence-[A-Za-z0-9_-]+$/.test(href) ? sourceText(label) : label;
}

export function KnowledgeAnswerMarkdown({
  text,
  onOpenKnowledgeLink,
}: {
  text: string;
  onOpenKnowledgeLink?: (href: string) => void;
}) {
  return <Markdown text={text} onOpenKnowledgeLink={onOpenKnowledgeLink}
    renderQuotedText={sourceText} renderKnowledgeLinkLabel={sourceLinkLabel} />;
}
