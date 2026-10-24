// scripts/ingest-docs.ts — 通用文档导入器：把 .md / .txt / .jsonl 的**正文**切块写入知识库
//
// 与 ingest-knowledge.ts 的分工：
//   - ingest-knowledge.ts --dir 只写「文件树」（路径 + 大小，≤500 条），给 Agent 看目录结构；
//   - 本脚本读文件**内容** → 按 Markdown 标题 / 段落切块 → 写入指定 collection，供检索与 RAG 使用。
//
// 用法：
//   node --import tsx scripts/ingest-docs.ts --dir <path> [--collection docs] [--ext md,txt,jsonl]
//        [--max-chars 3000] [--max-items 5000] [--max-file-bytes 2097152]
//        [--jsonl-field <field>] [--exclude runs,history] [--replace] [--build-index] [--dry-run] [--verbose]
//
// 幂等：itemId = `<相对路径>#<序号>`（jsonl 为 `<相对路径>#L<行号>`），重复执行是覆盖（刷新 FTS 与向量）。
// --replace：导入前清空同 collection 的旧条目——文件删改后不会残留孤儿块（直接删三张表，不写逐条审计）。
// 只读源：不修改源文件；只写 data_items / rag_chunks / audit_log。
//
// 注意：这里**不**调用 buildRuntime——那会触发「启动回收孤儿 run」的副作用（把正在运行的服务里
//       未完成的 run 标成 failed）。导入脚本只需要 SqliteStore + KnowledgeHub。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { loadEnv } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { EventLogger } from '../src/trace/EventLogger.js';
import { Tracer } from '../src/trace/Tracer.js';
import { ErrorReporter } from '../src/runtime/errorReporter.js';
import { KnowledgeHub } from '../src/knowledge/index.js';

loadEnv();

const args = process.argv.slice(2);
const valueOf = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return args[i + 1] ?? fallback;
};
const hasFlag = (name: string) => args.includes(`--${name}`);
const numOf = (name: string, fallback: number, min: number) => {
  const raw = valueOf(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
};

const scanPath = valueOf('dir');
if (!scanPath) {
  console.error(
    '用法：node --import tsx scripts/ingest-docs.ts --dir <path> [--collection docs] [--ext md,txt,jsonl] [--max-chars 3000] [--max-items 5000] [--max-file-bytes 2097152] [--jsonl-field text] [--exclude runs,history] [--replace] [--build-index] [--dry-run] [--verbose]',
  );
  process.exitCode = 1;
}

const collection = (valueOf('collection', 'docs') ?? 'docs').trim();
const exts = new Set(
  (valueOf('ext', 'md,mdx,txt,jsonl') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean),
);
const maxChars = numOf('max-chars', 3000, 200);
const maxItems = numOf('max-items', 5000, 1);
const maxFileBytes = numOf('max-file-bytes', 8 * 1024 * 1024, 1024);
const jsonlField = valueOf('jsonl-field');
const excludeDirs = new Set(
  (valueOf('exclude', '') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const replace = hasFlag('replace');
const buildIndex = hasFlag('build-index');
const dryRun = hasFlag('dry-run');
const verbose = hasFlag('verbose');

// ---------------------------------------------------------------------------
// ① 收集文件
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'build', '.cache', '.next', '.workbuddy', '.zcode']);
const files: string[] = [];
const walk = (dir: string) => {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith('.') || SKIP_DIRS.has(name) || excludeDirs.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full);
    else if (exts.has(extname(name).slice(1).toLowerCase())) files.push(full);
  }
};

let scanIsDir = false;
if (scanPath) {
  try {
    scanIsDir = statSync(scanPath).isDirectory();
  } catch {
    console.error(`[ingest-docs] 路径不存在：${scanPath}`);
    process.exitCode = 1;
  }
  if (scanPath && !scanIsDir) {
    try {
      if (exts.has(extname(scanPath).slice(1).toLowerCase())) files.push(scanPath);
      else console.error(`[ingest-docs] 扩展名不在 --ext 白名单：${scanPath}`);
    } catch {
      /* 已在上面的 statSync 报错 */
    }
  } else if (scanPath) {
    walk(scanPath);
  }
}

// ---------------------------------------------------------------------------
// ② 切块
// ---------------------------------------------------------------------------

interface Chunk {
  title: string;
  text: string;
}

/** 按 Markdown 标题（# / ## / …）切节；无标题的 txt 视为单节 */
function splitSections(text: string): Chunk[] {
  const lines = text.split(/\r?\n/);
  const sections: Chunk[] = [];
  let title = '';
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ title, text: body });
    buf = [];
  };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      title = m[2];
    }
    buf.push(line);
  }
  flush();
  return sections.length ? sections : [{ title: '', text }];
}

/** 把一节压到 maxChars 以内：优先按空行分段，超长段硬切；续块带标题前缀便于召回 */
function packSection(sec: Chunk, limit: number): Chunk[] {
  const body = sec.text.trim();
  if (body.length <= limit) return [{ title: sec.title, text: body }];
  const prefix = sec.title ? `[${sec.title}（续）]\n` : '';
  const out: Chunk[] = [];
  let buf = '';
  const push = () => {
    const t = buf.trim();
    if (t) out.push({ title: sec.title, text: out.length ? prefix + t : t });
    buf = '';
  };
  for (const para of body.split(/\n{2,}/)) {
    if (para.length > limit) {
      push();
      for (let i = 0; i < para.length; i += limit) {
        const piece = para.slice(i, i + limit);
        out.push({ title: sec.title, text: out.length ? prefix + piece : piece });
      }
      continue;
    }
    if (buf.length + para.length + 2 > limit) push();
    buf += (buf ? '\n\n' : '') + para;
  }
  push();
  return out;
}

const TEXT_FIELDS = ['text', 'content', 'code', 'body', 'answer', 'prompt', 'question', 'doc', 'passage'];

/** 从一行 JSON 里挑出正文：显式字段 > 常见字段名 > 最长字符串字段 */
function pickJsonlText(obj: unknown, preferred?: string): { field: string; text: string } | null {
  if (typeof obj === 'string') return { field: '', text: obj };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  if (preferred && typeof rec[preferred] === 'string') return { field: preferred, text: rec[preferred] as string };
  for (const f of TEXT_FIELDS) {
    if (typeof rec[f] === 'string' && (rec[f] as string).trim()) return { field: f, text: rec[f] as string };
  }
  let best: { field: string; text: string } | null = null;
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'string' && v.length > (best?.text.length ?? 0)) best = { field: k, text: v };
  }
  return best;
}

/** jsonl 里其余标量字段作为元数据（长文本不进 searchText） */
function scalarMeta(obj: unknown, exclude: string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (exclude.includes(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 200) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ③ 写入知识库
// ---------------------------------------------------------------------------

const config = loadConfig();
const store = dryRun ? null : new SqliteStore(config.sqlitePath);
const knowledge = store
  ? new KnowledgeHub(
      store.database,
      new Tracer(new EventLogger({ maxContentChars: config.log.maxContentChars })),
      new ErrorReporter(),
    )
  : null;

let written = 0;
let skippedFiles = 0;
let tooLarge = 0;
let totalChars = 0;
let stoppedAtLimit = false;
let aborted = false;

// --replace：先清空同 collection（data_items + FTS + RAG 块一起清，避免残留孤儿块）
if (replace && !dryRun && store && knowledge) {
  const rows = store.database
    .prepare('SELECT id, rowid AS r FROM data_items WHERE collection = ?')
    .all(collection) as Array<{ id: string; r: number }>;
  try {
    store.database.transaction(() => {
      // 统一后新库没有 data_vec：必须先探测，直接 prepare 会抛错把整个 --replace 回滚。
      const hasLegacyVec = !!store.database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'data_vec'")
        .get();
      const delVec = hasLegacyVec
        ? store.database.prepare('DELETE FROM data_vec WHERE data_id = ?')
        : null;
      const delFts = store.database.prepare('DELETE FROM data_items_fts WHERE rowid = ?');
      const delItem = store.database.prepare('DELETE FROM data_items WHERE id = ?');
      for (const row of rows) {
        try {
          // 旧库可能还有 data_vec（统一前遗留）；新库没有该表，忽略即可。
          delVec?.run(row.id);
        } catch {
          /* 表不存在（已统一到 RAG） */
        }
        delFts.run(row.r);
        delItem.run(row.id);
      }
    })();
    // rag_chunks 没有外键级联，必须显式删；否则 --replace 后旧块仍可能被检索到。
    knowledge.ragStore.removeDocs(rows.map((r) => r.id));
    console.log(`[ingest-docs] --replace：已清空 collection=${collection} 的 ${rows.length} 条旧数据`);
  } catch (e) {
    console.error(`[ingest-docs] --replace 失败（事务已回滚，未写入任何新数据）：${(e as Error).message}`);
    aborted = true;
    process.exitCode = 1;
  }
}

for (const file of files) {
  if (aborted) break;
  if (written >= maxItems) {
    stoppedAtLimit = true;
    break;
  }
  const baseDir = scanPath && scanIsDir ? scanPath : join(scanPath ?? '.', '..');
  const rel = relative(baseDir, file).replace(/\\/g, '/');
  const ext = extname(file).slice(1).toLowerCase();
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    skippedFiles += 1;
    continue;
  }
  if (size > maxFileBytes) {
    tooLarge += 1;
    // 始终列出被跳过的文件：整份跳过是「导入 0 条」最常见的原因，藏在汇总行里很难排查
    if (tooLarge <= 20) {
      console.log(`⊘ 跳过（${(size / 1024 / 1024).toFixed(1)} MiB > --max-file-bytes ${(maxFileBytes / 1024 / 1024).toFixed(1)} MiB）：${rel}`);
    }
    continue;
  }

  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    skippedFiles += 1;
    if (verbose) console.log(`✗ 读取失败 ${rel}: ${(e as Error).message}`);
    continue;
  }

  // ---- jsonl：一行一条
  if (ext === 'jsonl') {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (written >= maxItems) {
        stoppedAtLimit = true;
        break;
      }
      const line = lines[i].trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = line; // 非 JSON 行当纯文本
      }
      const picked = pickJsonlText(parsed, jsonlField);
      if (!picked || !picked.text.trim()) continue;
      // 长记录按 maxChars 切块（而不是截断），保证正文不丢
      const parts = packSection({ title: '', text: picked.text }, maxChars);
      for (let k = 0; k < parts.length; k++) {
        if (written >= maxItems) {
          stoppedAtLimit = true;
          break;
        }
        const body = parts[k].text;
        const itemId = parts.length === 1 ? `${rel}#L${i + 1}` : `${rel}#L${i + 1}-${k + 1}`;
        const content = {
          path: rel,
          line: i + 1,
          part: parts.length === 1 ? undefined : k + 1,
          field: picked.field,
          text: body,
          meta: scalarMeta(parsed, [picked.field]),
        };
        if (!dryRun) {
          knowledge!.putData({
            collection,
            itemId,
            type: 'jsonl',
            tags: [collection, 'jsonl', rel.split('/').slice(0, -1).join('/') || '.'],
            content,
            createdBy: 'ingest-docs',
          });
        }
        written += 1;
        totalChars += body.length;
        if (verbose) console.log(`＋ ${itemId} (${body.length} 字符, 字段 ${picked.field || 'raw'})`);
      }
      if (stoppedAtLimit) break;
    }
    continue;
  }

  // ---- md / txt：按标题切节 → 压到 maxChars
  const chunks: Chunk[] = [];
  for (const sec of splitSections(text)) chunks.push(...packSection(sec, maxChars));
  let n = 0;
  for (const c of chunks) {
    if (written >= maxItems) {
      stoppedAtLimit = true;
      break;
    }
    if (!c.text.trim()) continue;
    n += 1;
    const itemId = `${rel}#${n}`;
    if (!dryRun) {
      knowledge!.putData({
        collection,
        itemId,
        type: ext,
        tags: [collection, ext, rel.split('/').slice(0, -1).join('/') || '.'],
        content: { path: rel, title: c.title, section: n, text: c.text },
        createdBy: 'ingest-docs',
      });
    }
    written += 1;
    totalChars += c.text.length;
    if (verbose) console.log(`＋ ${itemId} (${c.text.length} 字符) ${c.title}`);
  }
}

const stats = knowledge ? knowledge.stats() : null;

console.log(
  `[ingest-docs] ${dryRun ? '（dry-run，未写库）' : ''}文件 ${files.length} 个 → 条目 ${written} 条` +
    `、正文 ${(totalChars / 1024).toFixed(1)} KiB；跳过 ${skippedFiles} 个（读取失败）、${tooLarge} 个（超大小上限）` +
    `${stoppedAtLimit ? `；已达 --max-items=${maxItems} 上限，未处理完` : ''}` +
    `${tooLarge ? '；超限文件可用 --max-file-bytes 放宽' : ''}`,
);
if (stats) {
  console.log(
    `[ingest-docs] collection=${collection} 已写入；知识库现状：total=${stats.repository.total} ${JSON.stringify(stats.repository.byCollection)}` +
      `；RAG 向量层：${stats.vector.embedder} dim=${stats.vector.dim} docs=${stats.vector.docs} chunks=${stats.vector.chunks}`,
  );
}

// --build-index：导入完立即构建切块级 RAG 索引并打印耗时/规模（用于压测与首次建库）
if (buildIndex && knowledge && !dryRun && !aborted && written > 0) {
  const t0 = Date.now();
  try {
    const pipeline = await knowledge.rebuildRag();
    console.log(`[ingest-docs] RAG 索引构建耗时 ${Date.now() - t0}ms：${JSON.stringify(pipeline.stats())}`);
  } catch (e) {
    console.error(`[ingest-docs] RAG 索引构建失败：${(e as Error).message}`);
    process.exitCode = 1;
  }
}

store?.close();
