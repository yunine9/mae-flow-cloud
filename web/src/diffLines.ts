/**
 * diff 行 → 新文件行号。批注定位的地基,所以单独成文件:web/ 没有测试
 * 运行器,拆出来根测试才钉得住它(算错一位,所有代码批注都指错地方)。
 */

/**
 * 每一行在**新文件**里的真实行号,从 `@@ -a,b +c,d @@` 的 c 起递推。
 *
 * 批注要落成 `SmsHandler.java:23`,不是"diff 里第 8 行"——后者对模型
 * 毫无意义,它手上的文件里没有"diff 第几行"这回事。删除行不占新文件的
 * 行号(它在新文件里已经不存在),所以只有上下文行和新增行往前走。
 * 拿不到行号的行(diff 头、hunk 头)返回 0,由调用方决定不给锚点。
 */
export function newFileLines(lines: string[]): number[] {
  const numbers: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      cursor = Number(hunk[1]);
      numbers.push(0);
      continue;
    }
    if (!cursor || /^diff --git |^index |^--- |^\+\+\+ |^\?\? /.test(line)) {
      numbers.push(0);
      continue;
    }
    if (/^-/.test(line)) {
      numbers.push(0);          // 删除行在新文件里不存在,不占行号
      continue;
    }
    numbers.push(cursor);
    cursor += 1;
  }
  return numbers;
}
