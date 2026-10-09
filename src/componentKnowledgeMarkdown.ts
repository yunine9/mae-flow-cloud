/** 来源记录单独保存；阅读与下载只显示使用知识，代码块保持原样。 */
export function componentKnowledgeMarkdown(text: string): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const output: string[] = [];
  let fence = "", sourceLevel = 0;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      if (!sourceLevel) output.push(line);
      continue;
    }
    if (!fence) {
      const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading && sourceLevel && (heading[1].length <= sourceLevel || /^(?:公共接口|集成产物与依赖|集成与依赖|最佳示例|完整示例|使用限制|关联组件)$/.test(heading[2]))) sourceLevel = 0;
      if (heading && /^(?:来源|萃取来源|来源依据|来源与证据|源码依据|参考来源|证据来源)$/.test(heading[2])) { sourceLevel = heading[1].length; continue; }
    }
    if (!sourceLevel) output.push(line);
  }
  return output.join("\n").trim();
}
