// scripts/ingest-knowledge.ts — 把历史对话与工作区内容纳入知识库（可检索 + 语义嵌入）
//
// 用法：node --import tsx scripts/ingest-knowledge.ts [--dir <repoPath>]
//   - 默认：把 runs（目标+最终答案/失败原因）与 context（多轮对话 turns）写入知识库；
//   - --dir：额外把指定工作区的文件结构（路径+大小，上限 500 条，跳过 node_modules/.git）写入 collection 'workspace'。
// 幂等：putData 按 (collection, itemId) 唯一，重复执行是覆盖（会刷新 embedding）。
// 只读源：不修改 runs/contexts 表，只写入知识库（data_items；向量由 RAG 增量索引维护）。

import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import { flattenSearchText } from '../src/knowledge/repository.js';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const config = loadConfig();
const { store, knowledge } = buildRuntime(config);

const args = process.argv.slice(2);
const dirFlagIdx = args.indexOf('--dir');
const scanDir = dirFlagIdx >= 0 ? args[dirFlagIdx + 1] : undefined;

let runCount = 0;
let turnCount = 0;
let wsCount = 0;

// ① 历史运行（对话目标 + 最终答案 / 失败原因）→ collection 'runs'
for (const rec of store.listRuns(100000)) {
  const content: Record<string, unknown> = {
    goal: rec.goal,
    runType: rec.runType,
    status: rec.status,
    finalAnswer: rec.finalAnswer ?? null,
    failureReason: rec.failureReason ?? null,
    errorCode: rec.errorCode ?? null,
    steps: rec.steps,
    modelCalls: rec.modelCalls,
    toolCalls: rec.toolCalls,
    createdAt: rec.createdAt,
  };
  const { item, isCreate } = knowledge.putData({
    collection: 'runs',
    itemId: rec.runId,
    type: rec.runType,
    tags: [rec.status, rec.runType],
    content,
    createdBy: 'ingest',
  });
  runCount += 1;
  if (process.env.DEBUG_INGEST) console.log(`${isCreate ? '＋' : '~'} run ${rec.runId} ${rec.status}`);
}

// ② 历史多轮对话 → collection 'conversations'
for (const sess of knowledge.context.listSessions(10000)) {
  const turns = knowledge.context.getTurns(sess.sessionId, 10000);
  for (const t of turns) {
    knowledge.putData({
      collection: 'conversations',
      itemId: `${sess.sessionId}:${t.turnNo}`,
      type: t.role,
      tags: [sess.sessionId],
      content: { sessionId: sess.sessionId, turnNo: t.turnNo, role: t.role, text: t.content, createdAt: t.createdAt },
      createdBy: 'ingest',
    });
    turnCount += 1;
  }
}

// ③ （可选）工作区文件结构索引 → collection 'workspace'
if (scanDir) {
  const root = scanDir.replace(/\\/g, '/');
  const entries: Array<{ path: string; size: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || entries.length >= 500) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (entries.length >= 500) return;
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else {
        entries.push({ path: relative(scanDir, full).replace(/\\/g, '/'), size: st.size });
      }
    }
  };
  walk(root, 0);
  for (const e of entries) {
    knowledge.putData({
      collection: 'workspace',
      itemId: `ws:${e.path}`,
      type: 'file',
      tags: [scanDir],
      content: { repo: scanDir, path: e.path, size: e.size },
      createdBy: 'ingest',
    });
    wsCount += 1;
  }
}

console.log(`[ingest] 完成：runs ${runCount} 条、对话 turns ${turnCount} 条${scanDir ? `、工作区文件 ${wsCount} 条` : ''}`);
console.log(`[ingest] 知识库现状：${JSON.stringify(knowledge.stats())}`);
store.close();
