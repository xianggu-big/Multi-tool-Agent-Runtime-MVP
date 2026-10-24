// scripts/cleanup-legacy-vector.ts — 清理统一前遗留的 data_vec(vec0) 表
//
// 2026-10-24 起检索只维护 rag_chunks；data_vec 不再写入，但历史库可能仍有该表。
// 默认 dry-run，只报告规模；加 --yes 才真正 DROP。请先停服务再执行（会短暂锁库）。
//   npm run rag:cleanup-legacy            # 只检查
//   npm run rag:cleanup-legacy -- --yes   # 删除表
//   npm run rag:cleanup-legacy -- --yes --vacuum  # 删除并回收磁盘空间（大库较慢）
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { loadEnv } from '../src/env.js';

loadEnv();

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const vacuum = args.includes('--vacuum');
const config = loadConfig();

if (!config.sqlitePath || config.sqlitePath === ':memory:') {
  console.error('[cleanup-legacy] 当前配置是内存库，没有可清理的文件。');
  process.exit(1);
}

const sizeMiB = existsSync(config.sqlitePath) ? statSync(config.sqlitePath).size / 1024 / 1024 : 0;
const db = new Database(config.sqlitePath);
try {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'data_vec'")
    .get() as { name?: string } | undefined;
  if (!table) {
    console.log('[cleanup-legacy] 没有 data_vec 表（已经统一或全新库），无需清理。');
  } else {
    let vectors = 0;
    try {
      vectors = Number((db.prepare('SELECT COUNT(*) AS c FROM data_vec').get() as { c?: number }).c ?? 0);
    } catch {
      /* 表存在但读取失败时仍允许 DROP */
    }
    console.log(`[cleanup-legacy] 发现 data_vec：${vectors} 条向量；库文件 ${sizeMiB.toFixed(1)} MiB`);
    if (!apply) {
      console.log('[cleanup-legacy] dry-run：确认服务已停止后，加 --yes 执行删除。');
    } else {
      const require = createRequire(import.meta.url);
      const sqliteVec = require('sqlite-vec') as { load: (d: Database.Database) => void };
      sqliteVec.load(db);
      db.exec('DROP TABLE data_vec');
      console.log('[cleanup-legacy] 已删除 data_vec（检索走 rag_chunks，不受影响）。');
      if (vacuum) {
        db.exec('VACUUM');
        console.log('[cleanup-legacy] VACUUM 完成，磁盘空间已回收。');
      } else {
        console.log('[cleanup-legacy] 想立即回收磁盘空间可加 --vacuum（大库较慢）。');
      }
    }
  }
} catch (e) {
  console.error(`[cleanup-legacy] 失败：${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
