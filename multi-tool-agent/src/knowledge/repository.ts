// src/knowledge/repository.ts — 数据仓库：分类 + 标签 + 持久化 + 高效全文检索
//
// 设计：
//   - 复用 SqliteStore 的同一 Database 连接（单库、单连接 → 跨表事务天然一致）。
//   - 全文检索用 SQLite FTS5（已探测可用），standalone 表 + 应用层同步（与数据行同事务写入），
//     保证「检索得到的一定是已落库的」。FTS5 不可用时自动降级到 LIKE（行为一致、仅扫描成本不同）。
//   - 分类维度：collection（命名空间）+ itemId（集合内业务 id，唯一）+ type（内容类型标记）+ tags[]。
//
// 与其它模块的契约：
//   - 本类**只**管数据读写与检索；**不**写 audit、不发事件——那两件事由 KnowledgeHub 门面统一做，
//     以保证「一次逻辑操作 = 一条 audit + 一条事件 + 同一 correlationId 贯穿三库」的可追溯性。

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface DataItem {
  id: string;
  collection: string;
  itemId: string;
  type?: string;
  tags: string[];
  content: unknown;
  searchText: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface PutDataInput {
  collection: string;
  /** 集合内业务 id；未提供则自动生成（data_<8位>） */
  itemId?: string;
  type?: string;
  tags?: string[];
  /** 任意 JSON 内容（会原样存） */
  content: unknown;
  /** 显式提供的主键（一般用不到；未提供则自动生成 UUID） */
  id?: string;
  /** 创建/修改者（actor）：runId / userId / 'system' */
  createdBy?: string;
}

export interface DataQueryFilter {
  collection?: string;
  type?: string;
  tag?: string;
  /** 全文检索词（FTS5 MATCH；查询失败/为空时退化为空过滤） */
  q?: string;
  limit?: number;
  offset?: number;
}

/** 把任意内容拍平成一行可检索的小写文本（供 FTS 索引与 LIKE 兜底共用） */
export function flattenSearchText(content: unknown, type?: string, tags?: string[], itemId?: string): string {
  const parts: string[] = [];
  if (itemId) parts.push(String(itemId));
  if (type) parts.push(String(type));
  if (tags?.length) parts.push(tags.map((t) => String(t)).join(' '));
  const walk = (v: unknown) => {
    if (v == null) return;
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') {
      for (const [, val] of Object.entries(v as Record<string, unknown>)) walk(val);
    }
  };
  walk(content);
  return parts.join(' ').toLowerCase().slice(0, 20000);
}

const COLUMNS =
  'id, collection, itemId, type, tagsJson, contentJson, searchText, createdAt, updatedAt, createdBy';

export class Repository {
  private ftsAvailable: boolean | null = null;

  constructor(private readonly db: Database.Database) {
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS data_items (
        id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        itemId TEXT NOT NULL,
        type TEXT,
        tagsJson TEXT NOT NULL DEFAULT '[]',
        contentJson TEXT,
        searchText TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        createdBy TEXT,
        UNIQUE(collection, itemId)
      );
      CREATE INDEX IF NOT EXISTS idx_data_collection ON data_items(collection);
      CREATE INDEX IF NOT EXISTS idx_data_type ON data_items(type);
      CREATE INDEX IF NOT EXISTS idx_data_updated ON data_items(updatedAt);
      CREATE INDEX IF NOT EXISTS idx_data_createdBy ON data_items(createdBy);
    `);
    // 全文检索：standalone FTS5 表（自身存内容），rowid 与 data_items 的隐式 rowid 对齐。
    // 探测失败（某些构建未启用 FTS5）时静默降级——检索仍可用 searchText LIKE 兜底。
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS data_items_fts USING fts5(content);`);
      this.ftsAvailable = true;
    } catch {
      this.ftsAvailable = false;
    }
  }

  /**
   * 写入或更新一条数据（按 collection+itemId 唯一）。
   * 返回 { item, isCreate, previous } —— 把「改前快照」交给调用方去写 audit。
   */
  put(input: PutDataInput): { item: DataItem; isCreate: boolean; previous: DataItem | null } {
    const now = new Date().toISOString();
    const collection = input.collection.trim();
    if (!collection) throw new Error('collection 不能为空');
    const itemId = (input.itemId ?? `data_${randomUUID().slice(0, 8)}`).trim();
    if (!itemId) throw new Error('itemId 不能为空');
    const tags = (input.tags ?? []).map((t) => String(t));
    const searchText = flattenSearchText(input.content, input.type, tags, itemId);

    const existing = this.get(collection, itemId);
    const id = existing?.id ?? input.id ?? `d_${randomUUID()}`;
    const isCreate = !existing;

    const tx = this.db.transaction(() => {
      if (existing) {
        this.db
          .prepare(
            `UPDATE data_items SET type=?, tagsJson=?, contentJson=?, searchText=?, updatedAt=?, createdBy=? WHERE id=?`,
          )
          .run(
            input.type ?? null,
            JSON.stringify(tags),
            JSON.stringify(input.content),
            searchText,
            now,
            input.createdBy ?? existing.createdBy,
            id,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO data_items (id, collection, itemId, type, tagsJson, contentJson, searchText, createdAt, updatedAt, createdBy)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            collection,
            itemId,
            input.type ?? null,
            JSON.stringify(tags),
            JSON.stringify(input.content),
            searchText,
            now,
            now,
            input.createdBy ?? null,
          );
      }
      this.syncFts(id, searchText);
    });
    tx();

    const item = this.getById(id)!;
    return { item, isCreate, previous: existing };
  }

  /** 同步 FTS 索引（与数据行同事务调用，保证一致） */
  private syncFts(id: string, searchText: string): void {
    if (!this.ftsAvailable) return;
    const row = this.db.prepare(`SELECT rowid AS r FROM data_items WHERE id=?`).get(id) as
      | { r: number }
      | undefined;
    if (!row) return;
    // 先删后插，避免 FTS 重复索引同一 rowid（OR REPLACE 语义在 FTS5 上不稳）
    this.db.prepare(`DELETE FROM data_items_fts WHERE rowid=?`).run(row.r);
    if (searchText) {
      this.db.prepare(`INSERT INTO data_items_fts (rowid, content) VALUES (?, ?)`).run(row.r, searchText);
    }
  }

  get(collection: string, itemId: string): DataItem | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM data_items WHERE collection=? AND itemId=?`)
      .get(collection, itemId) as any;
    return row ? this.rowToItem(row) : null;
  }

  getById(id: string): DataItem | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM data_items WHERE id=?`).get(id) as any;
    return row ? this.rowToItem(row) : null;
  }

  list(filter: DataQueryFilter = {}): DataItem[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.collection) {
      where.push('collection=?');
      params.push(filter.collection);
    }
    if (filter.type) {
      where.push('type=?');
      params.push(filter.type);
    }
    if (filter.tag) {
      // tags 是 JSON 数组：用 LIKE 做标签匹配（标签数量级一般不大，够用且索引友好）
      where.push("tagsJson LIKE ?");
      params.push(`%"${String(filter.tag).replace(/[%_"]/g, ' ')}"%`);
    }
    if (filter.q) {
      where.push('searchText LIKE ?');
      params.push(`%${filter.q.toLowerCase()}%`);
    }
    const sql = `SELECT ${COLUMNS} FROM data_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`;
    params.push(Math.max(1, Math.min(500, filter.limit ?? 50)));
    params.push(Math.max(0, filter.offset ?? 0));
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * 全文检索（高效，FTS5 MATCH）。FTS 不可用或查询语法错误时降级到 LIKE。
   * 返回命中条目（已按相关度排序）。
   */
  search(query: string, opts: { limit?: number; collection?: string } = {}): DataItem[] {
    const q = (query ?? '').trim();
    if (!q) return [];
    const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
    // FTS5 路径
    if (this.ftsAvailable) {
      try {
        // 用 prefix 查询提升容错（输入 fragment 也能命中词首）
        const ftsQuery = sanitizeFtsQuery(q);
        // 修复：FTS5 SQL 必须带 `MATCH ?`（此前缺 MATCH 且传参多于占位符 → 恒抛错静默降级 LIKE）。
        const rows = this.db
          .prepare(
            `SELECT d.id, d.collection, d.itemId, d.type, d.tagsJson, d.contentJson, d.searchText, d.createdAt, d.updatedAt, d.createdBy
             FROM data_items_fts
             JOIN data_items d ON d.rowid = data_items_fts.rowid
             WHERE data_items_fts MATCH ?
             ${opts.collection ? 'AND d.collection = ?' : ''}
             ORDER BY rank
             LIMIT ?`,
          )
          .all(ftsQuery, ...(opts.collection ? [opts.collection] : []), limit) as any[];
        if (rows.length > 0) {
          return rows.map((r) => this.rowToItem(r));
        }
        // FTS5 命中 0 条：可能是「非词首子串 / 连续 CJK 词」这类前缀查不到的形态
        // （如 searchData('漏洞') 命中 '登录漏洞'），退回 LIKE 子串检索兜底。
      } catch {
        // FTS5 语法错误 / 扩展异常 → 降级 LIKE
      }
    }
    // 降级：LIKE
    return this.list({ q, limit, collection: opts.collection });
  }

  /** 删除；返回被删对象（供 audit 记 before） */
  delete(collection: string, itemId: string): DataItem | null {
    const existing = this.get(collection, itemId);
    if (!existing) return null;
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM data_items WHERE collection=? AND itemId=?`).run(collection, itemId);
      if (this.ftsAvailable) {
        const r = this.db.prepare(`SELECT rowid AS r FROM data_items_fts`).all() as any[]; // 删后无对应行，FTS 用 rowid 不可达；改用 content 匹配兜底
        void r;
        this.db.prepare(`DELETE FROM data_items_fts WHERE content=?`).run(existing.searchText);
      }
    });
    tx();
    return existing;
  }

  /** 统计（供报告/健康检查） */
  stats(): { total: number; byCollection: Record<string, number>; fts: boolean } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM data_items`).get() as any).c as number;
    const rows = this.db
      .prepare(`SELECT collection, COUNT(*) AS c FROM data_items GROUP BY collection`)
      .all() as any[];
    const byCollection: Record<string, number> = {};
    for (const r of rows) byCollection[r.collection] = r.c;
    return { total, byCollection, fts: !!this.ftsAvailable };
  }

  private rowToItem(row: any): DataItem {
    return {
      id: row.id,
      collection: row.collection,
      itemId: row.itemId,
      type: row.type ?? undefined,
      tags: safeParseArr(row.tagsJson),
      content: row.contentJson ? JSON.parse(row.contentJson) : null,
      searchText: row.searchText ?? '',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy ?? undefined,
    };
  }
}

function safeParseArr(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** FTS5 查询转义：把用户输入拆成词，每个词加前缀匹配（输入 frag 也能命中），用空格 AND 连接 */
function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.replace(/["'^*]/g, ''))
    .filter(Boolean);
  if (!tokens.length) return '""';
  return tokens.map((t) => `"${t}"*`).join(' ');
}
