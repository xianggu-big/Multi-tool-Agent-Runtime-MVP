// src/knowledge/chunking.ts — 文档切块（chunk）层
//
// 目标：把长文档切成「足够小、又不丢上下文」的块，供向量/关键词检索使用。
// 设计取舍：
//   - 以 token 而不是字符为目标：模型上下文和 embedding 上限都按 token 计；
//   - 优先在段落/标题/句子边界切：比固定字符窗口更少截断语义；
//   - overlap 用「尾部完整句子」而不是字符滑窗：避免把一句话切成两半；
//   - 中文按字计、英文按约 4 字符/token 估算：离线、确定性、零依赖。
//
// 默认 512 tokens / 64 tokens overlap（12.5%）。理由：
//   - 512 对 FAQ/文档通常能容纳 2~4 个自然段，单块语义较纯；
//   - 64 的 overlap 足以覆盖「答案跨段」的边界，又不会让索引体积膨胀太多；
//   - 代码/表格较多时用 320/48，FAQ 用 256/32，长报告用 800/100。

export interface ChunkOptions {
  /** 目标块大小（估算 token） */
  chunkSize?: number;
  /** 相邻块重叠（估算 token），必须小于 chunkSize/2 */
  overlap?: number;
  /** 小于该 token 的尾块尝试并入前一块 */
  minChunkTokens?: number;
  /** 单个超长句子的硬切上限（字符），默认 chunkSize * 4 */
  maxCharsPerChunk?: number;
}

export interface ResolvedChunkOptions {
  chunkSize: number;
  overlap: number;
  minChunkTokens: number;
  maxCharsPerChunk: number;
}

export interface ChunkSource {
  id: string;
  text: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface Chunk {
  id: string;
  docId: string;
  chunkIndex: number;
  text: string;
  /** 用于 embedding 的文本（可带 title/heading 前缀；默认等于 text） */
  embedText: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
  heading?: string;
  title?: string;
  metadata: Record<string, unknown>;
}

export interface ChunkPreset {
  name: string;
  description: string;
  chunkSize: number;
  overlap: number;
  minChunkTokens: number;
}

export const CHUNK_PRESETS: Record<'docs' | 'code' | 'faq' | 'report', ChunkPreset> = {
  docs: {
    name: 'docs',
    description: '通用文档：512 tokens / 64 overlap（默认）',
    chunkSize: 512,
    overlap: 64,
    minChunkTokens: 80,
  },
  code: {
    name: 'code',
    description: '代码与配置：320 / 48，按空行与函数边界切',
    chunkSize: 320,
    overlap: 48,
    minChunkTokens: 40,
  },
  faq: {
    name: 'faq',
    description: 'FAQ / 短条目：256 / 32，减少无关上下文',
    chunkSize: 256,
    overlap: 32,
    minChunkTokens: 30,
  },
  report: {
    name: 'report',
    description: '长报告：800 / 100，保留跨节上下文',
    chunkSize: 800,
    overlap: 100,
    minChunkTokens: 120,
  },
};

export const DEFAULT_CHUNK_OPTIONS: ResolvedChunkOptions = {
  chunkSize: 512,
  overlap: 64,
  minChunkTokens: 80,
  maxCharsPerChunk: 512 * 4,
};

/**
 * 粗略 token 估算：CJK 约 1 字 = 1 token；拉丁字母/数字约 4 字符 = 1 token。
 * 这是离线启发式，不替代真实 tokenizer；用于切块预算而非计费。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let latin = 0;
  for (const ch of text ?? '') {
    const code = ch.codePointAt(0) ?? 0;
    if (isCjk(code)) cjk += 1;
    else if (/[A-Za-z0-9]/.test(ch)) latin += 1;
  }
  return Math.max(1, Math.ceil(cjk + latin / 4));
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

export function resolveChunkOptions(opts: ChunkOptions = {}): ResolvedChunkOptions {
  const chunkSize = clampInt(opts.chunkSize ?? DEFAULT_CHUNK_OPTIONS.chunkSize, 32, 8192);
  const maxOverlap = Math.max(0, Math.floor(chunkSize / 2) - 1);
  const overlap = clampInt(opts.overlap ?? DEFAULT_CHUNK_OPTIONS.overlap, 0, maxOverlap);
  const minChunkTokens = clampInt(
    opts.minChunkTokens ?? DEFAULT_CHUNK_OPTIONS.minChunkTokens,
    0,
    Math.max(0, chunkSize - 1),
  );
  const maxCharsPerChunk = clampInt(
    opts.maxCharsPerChunk ?? Math.max(chunkSize * 4, 128),
    64,
    1_000_000,
  );
  return { chunkSize, overlap, minChunkTokens, maxCharsPerChunk };
}

interface Piece {
  text: string;
  start: number;
  end: number;
  tokens: number;
  heading?: string;
}

interface Block {
  text: string;
  start: number;
  end: number;
  heading?: string;
}

/**
 * 切一个文档。返回的 charStart/charEnd 基于**归一化后的 LF 文本**。
 * 同一输入 + 同一参数 → 完全确定的 id / 边界 / 顺序。
 */
export function chunkDocument(source: ChunkSource, opts: ChunkOptions = {}): Chunk[] {
  const o = resolveChunkOptions(opts);
  const text = normalizeNewlines(source.text ?? '');
  if (!text.trim()) return [];

  const blocks = splitBlocks(text);
  const chunks: Chunk[] = [];
  let current: { pieces: Piece[]; tokens: number; heading?: string } | null = null;

  const emit = () => {
    if (!current || current.pieces.length === 0) return;
    const first = current.pieces[0];
    const last = current.pieces[current.pieces.length - 1];
    const raw = text.slice(first.start, last.end).trim();
    if (!raw) {
      current = null;
      return;
    }
    const index = chunks.length;
    const heading = current.heading;
    const header = raw.startsWith('#') ? undefined : heading;
    const embedText = [source.title, header, raw].filter(Boolean).join('\n').trim();
    chunks.push({
      id: `${source.id}#${index}`,
      docId: source.id,
      chunkIndex: index,
      text: raw,
      embedText,
      charStart: first.start,
      charEnd: last.end,
      tokenEstimate: estimateTokens(raw),
      heading,
      title: source.title,
      metadata: {
        ...(source.metadata ?? {}),
        docId: source.id,
        title: source.title,
        heading,
        chunkIndex: index,
        charStart: first.start,
        charEnd: last.end,
      },
    });
    current = null;
  };

  for (const block of blocks) {
    const sentences = splitSentences(block.text, block.start, block.heading);
    for (const sentence of sentences) {
      const pieces = sentence.tokens > o.chunkSize
        ? hardSplit(sentence, o.chunkSize, o.maxCharsPerChunk)
        : [sentence];

      for (const piece of pieces) {
        if (current && current.tokens + piece.tokens > o.chunkSize) {
          const tail = overlapTail(current.pieces, o.overlap, o.chunkSize);
          const carriedHeading: string | undefined = current.heading;
          emit();
          if (tail.length) {
            current = {
              pieces: tail,
              tokens: tail.reduce((n, p) => n + p.tokens, 0),
              heading: carriedHeading,
            };
          }
        }
        if (!current) current = { pieces: [], tokens: 0, heading: block.heading };
        if (!current.heading && block.heading) current.heading = block.heading;
        current.pieces.push(piece);
        current.tokens += piece.tokens;
      }
    }
  }
  emit();

  // 过短的尾块并入前一块（避免检索时出现「只有一句话」的碎片）。
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (last.tokenEstimate < o.minChunkTokens && prev.tokenEstimate + last.tokenEstimate <= o.chunkSize * 1.25) {
      // 相邻块可能带 overlap：这里必须按原文字符区间重新截取，
      // 不能把 prev.text 和 last.text 直接拼接，否则重叠句子会被复制、偏移也会失真。
      const mergedText = text.slice(prev.charStart, last.charEnd).trim();
      if (mergedText) {
        const mergedHeader = mergedText.startsWith('#') ? undefined : prev.heading;
        prev.text = mergedText;
        prev.embedText = [prev.title, mergedHeader, mergedText].filter(Boolean).join('\n').trim();
        prev.charEnd = last.charEnd;
        prev.tokenEstimate = estimateTokens(mergedText);
        prev.metadata = { ...prev.metadata, charEnd: last.charEnd };
        chunks.pop();
      }
    }
  }

  // 合并后重排 chunkIndex，保持 id 与 index 一致。
  return chunks.map((c, i) => ({
    ...c,
    id: `${source.id}#${i}`,
    chunkIndex: i,
    metadata: { ...c.metadata, chunkIndex: i },
  }));
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let heading: string | undefined;
  let buf = '';
  let bufStart = -1;
  let offset = 0;

  const flush = (endOffset: number) => {
    if (!buf.trim()) {
      buf = '';
      bufStart = -1;
      return;
    }
    blocks.push({
      text: buf.replace(/\s+$/, ''),
      start: bufStart,
      end: Math.min(text.length, endOffset),
      heading,
    });
    buf = '';
    bufStart = -1;
  };

  for (const line of text.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    const h = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (h) {
      flush(lineStart);
      heading = h[2].trim();
      bufStart = lineStart;
      buf = `${line}\n`;
      continue;
    }
    if (!line.trim()) {
      flush(lineStart);
      continue;
    }
    if (bufStart < 0) bufStart = lineStart;
    buf += `${line}\n`;
  }
  flush(text.length);
  return blocks;
}

function splitSentences(text: string, baseOffset: number, heading?: string): Piece[] {
  const pieces: Piece[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let boundary = false;
    if ('。！？!?；;'.includes(ch)) boundary = true;
    else if (ch === '\n') boundary = true;
    else if (ch === '.' && /\s/.test(text[i + 1] ?? '') && /[A-Z0-9\u4e00-\u9fff]/.test(text[i + 2] ?? '')) {
      boundary = true;
    }
    if (!boundary) continue;
    const end = i + 1;
    const pieceText = text.slice(start, end);
    if (pieceText.trim()) {
      pieces.push({
        text: pieceText,
        start: baseOffset + start,
        end: baseOffset + end,
        tokens: estimateTokens(pieceText),
        heading,
      });
    }
    start = end;
  }
  const rest = text.slice(start);
  if (rest.trim()) {
    pieces.push({
      text: rest,
      start: baseOffset + start,
      end: baseOffset + text.length,
      tokens: estimateTokens(rest),
      heading,
    });
  }
  return pieces;
}

function hardSplit(piece: Piece, chunkSize: number, maxChars: number): Piece[] {
  const ratio = Math.max(2, Math.floor(piece.text.length / Math.max(1, piece.tokens)));
  const rawChars = Math.max(64, Math.min(maxChars, chunkSize * ratio));
  const out: Piece[] = [];
  for (let i = 0; i < piece.text.length; i += rawChars) {
    const part = piece.text.slice(i, i + rawChars);
    if (!part.trim()) continue;
    out.push({
      text: part,
      start: piece.start + i,
      end: piece.start + i + part.length,
      tokens: estimateTokens(part),
      heading: piece.heading,
    });
  }
  return out.length ? out : [piece];
}

/** 取尾部若干完整句子做 overlap；不把整块都带进下一块。 */
function overlapTail(pieces: Piece[], overlapTokens: number, chunkSize: number): Piece[] {
  if (overlapTokens <= 0 || pieces.length <= 1) return [];
  const tail: Piece[] = [];
  let tokens = 0;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    if (tokens + p.tokens > overlapTokens && tail.length > 0) break;
    if (p.tokens >= chunkSize) break;
    tail.unshift(p);
    tokens += p.tokens;
    if (tokens >= overlapTokens) break;
  }
  // 至少留一块正文，避免 overlap 变成整块复制。
  if (tail.length >= pieces.length) tail.shift();
  return tail;
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.floor(v)));
}
