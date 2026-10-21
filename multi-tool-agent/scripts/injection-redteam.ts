// scripts/injection-redteam.ts — 提示注入红队样本集评测
//
// 运行：npm run security:redteam
// 产出：reports/INJECTION_REDTEAM.md
//
// 诚实边界：这是**固定样本集的启发式检测评测**，不是“防住提示注入”的证明。
// 样本集同时包含已知缺口（纯 base64、URL 编码）与已知误报（安全文档提到攻击短语），
// 报告必须把它们留在表里，不能只报好看的数字。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanUntrusted } from '../src/security/untrusted.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const REPO = resolve(PROJECT, '..');
const CORPUS = join(PROJECT, 'eval', 'security-redteam', 'corpus.json');
const OUT = join(PROJECT, 'reports', 'INJECTION_REDTEAM.md');

interface Sample {
  id: string;
  category: string;
  expect: 'flag' | 'allow';
  text: string;
  note?: string;
}

interface Row extends Sample {
  flagged: boolean;
  hits: string[];
  correct: boolean;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 220);
}

function main(): void {
  const samples = JSON.parse(readFileSync(CORPUS, 'utf8')) as Sample[];
  const rows: Row[] = samples.map((s) => {
    const scan = scanUntrusted(s.text);
    const expected = s.expect === 'flag';
    return { ...s, flagged: scan.flagged, hits: scan.hits.map((h) => h.id), correct: scan.flagged === expected };
  });
  const malicious = rows.filter((r) => r.expect === 'flag');
  const benign = rows.filter((r) => r.expect === 'allow');
  const detected = malicious.filter((r) => r.flagged);
  const falsePositives = benign.filter((r) => r.flagged);
  const missed = malicious.filter((r) => !r.flagged);
  const correct = rows.filter((r) => r.correct);
  const categories = [...new Set(rows.map((r) => r.category))].sort();

  const lines: string[] = [];
  lines.push('# 提示注入红队评测');
  lines.push('');
  lines.push(`> 生成时间：${new Date().toISOString()}；命令：\`npm run security:redteam\`；生成物请重跑命令，不要手改数字。`);
  lines.push('');
  lines.push('## 1. 口径与边界');
  lines.push('');
  lines.push('- 被测对象：`src/security/untrusted.ts` 的 `scanUntrusted()`（中英文/多语言特征 + 零宽字符与中文夹空格归一化）。');
  lines.push('- 样本集：`eval/security-redteam/corpus.json`，包含恶意样本、正常技术文本、以及**已知缺口/已知误报**。');
  lines.push('- 这不是“防住提示注入”的证明：启发式检测可被改写、编码、翻译绕过；硬边界仍是工具白名单/权限/沙箱/审批。');
  lines.push('- 命中后的动作是「标记 run + 禁用粘性自动放行」，不是静默阻断；用户仍然可以做最终决定。');
  lines.push('');
  lines.push('## 2. 汇总');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---:|');
  lines.push(`| 样本总数 | ${rows.length} |`);
  lines.push(`| 恶意样本检出 | ${detected.length}/${malicious.length}（${pct(malicious.length ? detected.length / malicious.length : 0)}） |`);
  lines.push(`| 正常样本误报 | ${falsePositives.length}/${benign.length}（${pct(benign.length ? falsePositives.length / benign.length : 0)}） |`);
  lines.push(`| 总体判定正确 | ${correct.length}/${rows.length}（${pct(rows.length ? correct.length / rows.length : 0)}） |`);
  lines.push('');
  lines.push('**读法**：检出率高不代表安全；误报率会直接影响「读到正常文档也被标红」的体验。两类错误都要留在报告里。');
  lines.push('');
  lines.push('## 3. 按类别');
  lines.push('');
  lines.push('| 类别 | 样本 | 判定正确 | 说明 |');
  lines.push('|---|---:|---:|---|');
  for (const c of categories) {
    const list = rows.filter((r) => r.category === c);
    const ok = list.filter((r) => r.correct).length;
    const desc = c === 'benign' ? '正常技术文本/安全文档' : c;
    lines.push(`| ${cell(desc)} | ${list.length} | ${ok} | ${pct(list.length ? ok / list.length : 0)} |`);
  }
  lines.push('');
  lines.push('## 4. 未命中与误报');
  lines.push('');
  if (!missed.length && !falsePositives.length) {
    lines.push('无。');
  } else {
    if (missed.length) {
      lines.push('### 漏检（恶意样本未命中）');
      lines.push('');
      lines.push('| ID | 类别 | 样本 | 备注 |');
      lines.push('|---|---|---|---|');
      for (const r of missed) lines.push(`| ${r.id} | ${cell(r.category)} | ${cell(r.text)} | ${cell(r.note ?? '')} |`);
      lines.push('');
    }
    if (falsePositives.length) {
      lines.push('### 误报（正常样本被命中）');
      lines.push('');
      lines.push('| ID | 类别 | 样本 | 命中特征 | 备注 |');
      lines.push('|---|---|---|---|---|');
      for (const r of falsePositives) {
        lines.push(`| ${r.id} | ${cell(r.category)} | ${cell(r.text)} | ${cell(r.hits.join('、'))} | ${cell(r.note ?? '')} |`);
      }
      lines.push('');
    }
  }
  lines.push('## 5. 全量样本');
  lines.push('');
  lines.push('| ID | 类别 | 期望 | 实际 | 命中特征 | 样本 |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    const actual = r.flagged ? 'flag' : 'allow';
    const mark = r.correct ? '✅' : '❌';
    lines.push(`| ${r.id} | ${cell(r.category)} | ${r.expect} | ${mark} ${actual} | ${cell(r.hits.join('、'))} | ${cell(r.text)} |`);
  }
  lines.push('');
  lines.push('## 6. 复现');
  lines.push('');
  lines.push('```powershell');
  lines.push('cd multi-tool-agent');
  lines.push('npm run security:redteam');
  lines.push('```');
  lines.push('');
  lines.push('严格模式（有漏检/误报就退出 1）：`npm run security:redteam -- --strict`。当前不建议直接接 CI 硬门禁：已知缺口会误伤，先把样本集扩到更多真实形态。');
  lines.push('');
  lines.push('## 7. 下一步');
  lines.push('');
  lines.push('- 扩样本：真实网页/仓库里的注入、编码变体、更长上下文；不要只加同义词。');
  lines.push('- 对「删除 / 外传密钥 / 发布 / 改审批配置」做独立二次确认，而不是只依赖 run 污点。');
  lines.push('- 评估把扫描结果做成来源级 provenance；当前是 run 级污点，保守但粒度粗。');
  lines.push('');
  const report = lines.join('\n');
  writeFileSync(OUT, report.replace(/\r?\n/g, '\r\n'), 'utf8');
  console.log(`[security:redteam] 报告：${join('reports', 'INJECTION_REDTEAM.md')}`);
  console.log(
    `[security:redteam] 恶意 ${detected.length}/${malicious.length}，正常误报 ${falsePositives.length}/${benign.length}，总体 ${correct.length}/${rows.length}`,
  );
  if (missed.length) console.log(`[security:redteam] 漏检：${missed.map((r) => r.id).join(', ')}`);
  if (falsePositives.length) console.log(`[security:redteam] 误报：${falsePositives.map((r) => r.id).join(', ')}`);
  const strict = process.argv.slice(2).includes('--strict');
  if (strict && (missed.length || falsePositives.length)) process.exitCode = 1;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  try {
    main();
  } catch (e) {
    console.error(`[security:redteam] 失败：${(e as Error).message}`);
    process.exitCode = 1;
  }
}