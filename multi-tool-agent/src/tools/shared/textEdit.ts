// src/tools/shared/textEdit.ts — 文本编辑的行尾/编码策略（M1 Step3，评审 P1-7）
//
// 背景（实测）：本仓库文件是 CRLF（src/server.ts 975 行 CRLF），而模型生成的 oldString
// 通常是 LF。若按字节精确匹配，"唯一命中"会大面积失败；且若不按原行尾写回，会产生
// "整文件行尾翻转"的伪 diff（沙箱绿宿主红的一种隐形来源）。
//
// 策略：
//   ① 匹配：两边都去掉 BOM、把 CRLF 归一化为 LF 后再匹配（忽略行尾差异）；
//   ② 写回：把新内容的行尾统一成**原文件的主导行尾**，并恢复原文件的 BOM；
//   ③ 新建文件：沿用同目录既有文件的主导行尾（仓库约定），无参照时用 CRLF（本仓库约定）。

export interface EolInfo {
  bom: string; // '\uFEFF' 或 ''
  eol: '\r\n' | '\n';
}

/** 探测 BOM 与主导行尾（\r\n 出现次数 >= \n 总数一半 → CRLF） */
export function detectEol(text: string): EolInfo {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/(?<!\r)\n/g) ?? []).length;
  const eol: '\r\n' | '\n' = crlf > 0 && crlf >= lf ? '\r\n' : '\n';
  return { bom, eol };
}

/** 归一化：去 BOM、CRLF → LF（仅用于匹配/插入计算，不用于落盘） */
export function normalizeForMatch(text: string): string {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  return body.replace(/\r\n/g, '\n');
}

/** 把 LF 文本按指定行尾/BOM 还原成落盘形态 */
export function restoreEol(lfText: string, info: EolInfo): string {
  const body = info.eol === '\r\n' ? lfText.replace(/\n/g, '\r\n') : lfText;
  return info.bom + body;
}

export type EditOutcome =
  | { ok: true; content: string; replacedAt: number; eol: '\r\n' | '\n'; bom: boolean }
  | { ok: false; reason: string };

/**
 * 精确替换（oldString 必须唯一命中；忽略行尾差异、忽略 BOM）：
 *  - 命中 0 处 → 给出可行动原因（含"已忽略行尾差异"的说明与长度提示）；
 *  - 命中 >1 处 → 拒绝（要求更长的上下文，防止改错位置）；
 *  - 成功 → 返回**可落盘**的完整内容（行尾/BOM 与原文件一致）。
 */
export function applyEdit(original: string, oldString: string, newString: string): EditOutcome {
  const info = detectEol(original);
  const orig = normalizeForMatch(original);
  const oldS = normalizeForMatch(oldString);
  const newS = normalizeForMatch(newString);
  if (!oldS) return { ok: false, reason: 'oldString 不能为空（新建文件请用 create_file）' };

  // 唯一命中校验
  let count = 0;
  let firstAt = -1;
  for (let i = orig.indexOf(oldS); i !== -1; i = orig.indexOf(oldS, i + 1)) {
    count++;
    if (firstAt === -1) firstAt = i;
    if (count > 1) break;
  }
  if (count === 0) {
    return {
      ok: false,
      reason:
        'oldString 在文件里找不到（已忽略 CRLF/LF 差异后仍无匹配）。可行动修正：' +
        '① 先用 read_file 确认原文（含缩进与空白）；② oldString 必须逐字一致（不要省略中间行）；③ 若文件是新建的，请用 create_file。',
    };
  }
  if (count > 1) {
    return {
      ok: false,
      reason: `oldString 命中 ${count} 处、不唯一——拒绝执行以免改错位置。可行动修正：把 oldString 扩展到包含上下文的唯一片段。`,
    };
  }
  const lfResult = orig.slice(0, firstAt) + newS + orig.slice(firstAt + oldS.length);
  return { ok: true, content: restoreEol(lfResult, info), replacedAt: firstAt, eol: info.eol, bom: info.bom !== '' };
}

/** 统计 unified diff 的行数摘要（供审批卡/事件用；不解析具体 hunk） */
export function diffStat(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}
