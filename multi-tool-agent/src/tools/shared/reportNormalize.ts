// src/tools/shared/reportNormalize.ts — 上报结构的「宽容归一化」
//
// 真实事故驱动：模型非常习惯把数组元素写成**字符串**而不是对象，例如
//   findings: ["src/calc.js:1 无可疑硬编码", "test/calc.test.js 未发现 TODO"]
//   items:    ["文件数: 3", "总大小: 1.0KB"]
// 而契约要求 {path,note} / {label,value} —— 于是每次上报都被 Zod 打回，
// 一次多 Agent 运行里因此产生 9 次 INVALID_ARGS，白白烧掉子 Agent 的步数预算。
//
// 原则：**输出类结构可以宽容**（信息不丢就行，形状由 Runtime 归一化）；
//       但输入类结构（如 subtasks 的 specId/inputs）必须严格——目标与边界不能靠猜。
// 归一化后仍会标注"来源未标注"这类缺失，不假装合规。

export interface NormalizedItem {
  label: string;
  value: string | number;
  detail?: string;
}

export interface NormalizedFinding {
  path: string;
  note: string;
}

export interface NormalizedOrchFinding {
  from: string;
  note: string;
  path?: string;
}

const LABEL_SEP = /[:：=]/;
const PATH_LIKE = /([\\/]|\.[A-Za-z0-9]{1,6}\b)/;
/**
 * 找「路径」与「说明」之间的分隔符。按优先级：
 *   ① 破折号/管道（` — ` / ` - ` / `|`）
 *   ② **冒号 + 空格**（`src/a.js:1 说明` 里的 `:` 后面是数字，不算分隔符——这是最坑的一种）
 * 都不匹配时返回 null，由调用方尝试"首个像路径的 token"策略。
 */
function findNoteSeparator(s: string): RegExpExecArray | null {
  return /\s(?:—|–|-|::|\|)\s/.exec(s) ?? /[:：]\s+/.exec(s);
}

/** "文件数: 3" → { label: '文件数', value: '3' }；无分隔符 → { label: 整串, value: '' } */
export function normalizeItems(raw: unknown, max = 50): NormalizedItem[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out: NormalizedItem[] = [];
  for (const v of raw.slice(0, max)) {
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) continue;
      const m = LABEL_SEP.exec(s);
      if (m && m.index > 0) {
        out.push({ label: s.slice(0, m.index).trim().slice(0, 200), value: s.slice(m.index + m[0].length).trim().slice(0, 500) });
      } else {
        out.push({ label: s.slice(0, 200), value: '' });
      }
      continue;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const label = typeof o.label === 'string' ? o.label : typeof o.name === 'string' ? o.name : undefined;
      const value = typeof o.value === 'string' || typeof o.value === 'number' ? o.value : undefined;
      if (label && value !== undefined) {
        out.push({
          label: label.slice(0, 200),
          value: typeof value === 'string' ? value.slice(0, 500) : value,
          ...(typeof o.detail === 'string' ? { detail: o.detail.slice(0, 1000) } : {}),
        });
      } else if (label) {
        out.push({ label: label.slice(0, 200), value: '' });
      }
    }
  }
  return out.length ? out : undefined;
}

/** "src/calc.js:1 未发现 TODO" → { path: 'src/calc.js:1', note: '未发现 TODO' } */
export function normalizeFindings(raw: unknown, max = 20): NormalizedFinding[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out: NormalizedFinding[] = [];
  for (const v of raw.slice(0, max)) {
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) continue;
      const m = findNoteSeparator(s);
      if (m && m.index > 0) {
        const head = s.slice(0, m.index).trim();
        const tail = s.slice(m.index + m[0].length).trim();
        // 头部像路径 → 当 path；否则整串都是 note（path 标未标注）
        if (PATH_LIKE.test(head)) out.push({ path: head.slice(0, 500), note: tail.slice(0, 1000) || '（未给出说明）' });
        else out.push({ path: '（未标注路径）', note: s.slice(0, 1000) });
        continue;
      }
      // 无显式分隔符：把「首个像路径的 token」当 path，其余当 note
      // 例："src/calc.js:1 未发现 TODO" → path=src/calc.js:1, note=未发现 TODO
      const tokenMatch = /^(\S+)\s+([\s\S]+)$/.exec(s);
      if (tokenMatch && PATH_LIKE.test(tokenMatch[1])) {
        out.push({ path: tokenMatch[1].slice(0, 500), note: tokenMatch[2].slice(0, 1000) });
      } else {
        out.push({ path: PATH_LIKE.test(s) ? s.slice(0, 500) : '（未标注路径）', note: s.slice(0, 1000) });
      }
      continue;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const path = typeof o.path === 'string' ? o.path : typeof o.file === 'string' ? o.file : undefined;
      const note = typeof o.note === 'string' ? o.note : typeof o.message === 'string' ? o.message : undefined;
      if (path || note) {
        out.push({ path: (path ?? '（未标注路径）').slice(0, 500), note: (note ?? '').slice(0, 1000) });
      }
    }
  }
  return out.length ? out : undefined;
}

/**
 * 编排汇总的 findings：必须能标注来源（from）。
 * 字符串形式无法给出来源 → 标为 `（未标注来源）`，并把这一事实如实回报（不假装合规）。
 */
export function normalizeOrchFindings(
  raw: unknown,
  max = 80,
): { findings?: NormalizedOrchFinding[]; missingFromCount: number } {
  if (!Array.isArray(raw) || !raw.length) return { missingFromCount: 0 };
  const out: NormalizedOrchFinding[] = [];
  let missingFromCount = 0;
  for (const v of raw.slice(0, max)) {
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) continue;
      missingFromCount += 1;
      out.push({ from: '（未标注来源）', note: s.slice(0, 1000) });
      continue;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const from = typeof o.from === 'string' && o.from.trim() ? o.from : undefined;
      const note = typeof o.note === 'string' ? o.note : typeof o.message === 'string' ? o.message : undefined;
      if (!note) continue;
      if (!from) missingFromCount += 1;
      out.push({
        from: (from ?? '（未标注来源）').slice(0, 200),
        note: note.slice(0, 1000),
        ...(typeof o.path === 'string' ? { path: o.path.slice(0, 500) } : {}),
      });
    }
  }
  return { findings: out.length ? out : undefined, missingFromCount };
}
