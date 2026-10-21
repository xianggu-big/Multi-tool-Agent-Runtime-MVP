// src/tools/research/fetchPage.ts — 获取公开网页（SSRF 防护 + 限制）
// 安全边界：阻止 localhost/私网/云元数据；重定向后重新校验目标；
//           限制最大响应大小、连接/总超时、重定向次数；拒绝不支持的文件类型。

import { URL } from 'node:url';
import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';
import { lookup } from 'node:dns';
import { checkUrl, isPrivateV4, isPrivateV6 } from './ssrf.js';

const inputSchema = z.object({
  url: z.string().url().describe('要获取的公开网页 URL'),
  maxBytes: z.number().int().min(1024).max(5_000_000).default(512_000).describe('最大响应字节数'),
  timeoutMs: z.number().int().min(1000).max(60000).default(10000).describe('总超时（毫秒）'),
  maxRedirects: z.number().int().min(0).max(10).default(5).describe('最大重定向次数'),
});

const ALLOWED_CT = ['text/html', 'text/plain', 'application/json', 'application/xml', 'application/xhtml+xml'];

function htmlToText(html: string): string {
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim().slice(0, 200) : undefined;
}

export async function fetchOne(
  url: string,
  timeoutMs: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ res: Response; body: string; truncated: boolean; bytes: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  // 组合外部取消信号
  if (signal.aborted) ac.abort();
  const onAbort = () => ac.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { redirect: 'manual', signal: ac.signal as any });
    if (!res.ok && res.status !== 301 && res.status !== 302 && res.status !== 303 && res.status !== 307 && res.status !== 308) {
      const body = await res.text().catch(() => '');
      return { res, body: body.slice(0, 500), truncated: false, bytes: 0 };
    }
    if (res.status >= 300 && res.status < 400) {
      return { res, body: '', truncated: false, bytes: 0 };
    }
    // 读取并限制大小
    const ct = res.headers.get('content-type') ?? '';
    if (!ALLOWED_CT.some((a) => ct.toLowerCase().startsWith(a))) {
      return { res, body: '', truncated: false, bytes: 0 }; // 由调用方按状态码/类型判定
    }
    const reader = res.body?.getReader();
    let truncated = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        if (bytes + chunk.length > maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - bytes));
          bytes = maxBytes;
          truncated = true;
          break;
        }
        chunks.push(chunk);
        bytes += chunk.length;
      }
    }
    return { res, body: Buffer.concat(chunks).toString('utf8'), truncated, bytes };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * DNS 解析后 IP 复核：返回 true 表示 host 解析出的 IP 落在私网/回环/链路本地/云元数据段。
 * 解析失败/超时按 fail-open 处理（不因离线或临时解析失败阻断正常公网访问）。
 */
function resolvesToPrivate(hostname: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const finish = (val: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    timer = setTimeout(() => finish(false), 2000);
    lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return finish(false);
      finish(
        addrs.some((a) => (a.address.includes(':') ? isPrivateV6(a.address) : isPrivateV4(a.address))),
      );
    });
  });
}

export const fetchPage: Tool = {
  name: 'fetch_page',
  description: '获取允许访问的公开网页，提取正文并限制响应大小；阻止 localhost/私网/云元数据及危险重定向。',
  inputSchema,
  timeoutMs: 15000,
  permission: 'research:web',
  riskLevel: 'low',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    const args = input as z.infer<typeof inputSchema>;

    // 初始目标 SSRF 校验
    const initial = checkUrl(args.url, ctx.research?.allowedDomains);
    if (!initial.ok) {
      return errResult('SSRF_BLOCKED', `目标被拒绝: ${initial.reason}`, Date.now() - started);
    }

    let current = args.url;
    let redirectsLeft = args.maxRedirects;
    const deadline = Date.now() + args.timeoutMs;

    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return errResult('NETWORK_ERROR', `请求超时（总预算 ${args.timeoutMs}ms，含重定向）`, Date.now() - started);
        }
        const check = checkUrl(current, ctx.research?.allowedDomains);
        if (!check.ok) {
          return errResult('SSRF_BLOCKED', `重定向目标被拒绝: ${check.reason} (${current})`, Date.now() - started);
        }
        // DNS 解析后 IP 复核：即便 host 是「公网域名」，解析出的 IP 落在私网/回环/云元数据段也拒绝（防 rebinding）。
        const hostForDns = new URL(current).hostname.toLowerCase();
        if (await resolvesToPrivate(hostForDns)) {
          return errResult('SSRF_BLOCKED', `DNS 解析到私网/元数据地址被禁止: ${hostForDns}`, Date.now() - started);
        }
        if (Date.now() >= deadline) {
          return errResult('NETWORK_ERROR', `请求超时（总预算 ${args.timeoutMs}ms，含 DNS/重定向）`, Date.now() - started);
        }
        const r = await fetchOne(
          current,
          Math.max(1, deadline - Date.now()),
          args.maxBytes,
          ctx.signal ?? new AbortController().signal,
        );
        if (r.res.status >= 300 && r.res.status < 400) {
          const loc = r.res.headers.get('location');
          if (!loc) return errResult('REDIRECT_ERROR', '重定向缺少 Location', Date.now() - started);
          current = new URL(loc, current).toString();
          if (redirectsLeft-- <= 0) {
            return errResult('TOO_MANY_REDIRECTS', `超过最大重定向次数 ${args.maxRedirects}`, Date.now() - started);
          }
          continue;
        }
        const ct = r.res.headers.get('content-type') ?? '';
        if (!r.res.ok) {
          return errResult('HTTP_ERROR', `HTTP ${r.res.status}: ${r.body.slice(0, 200)}`, Date.now() - started);
        }
        if (!ALLOWED_CT.some((a) => ct.toLowerCase().startsWith(a))) {
          return errResult('UNSUPPORTED_TYPE', `不支持的内容类型: ${ct || 'unknown'}`, Date.now() - started);
        }
        const text = ct.toLowerCase().includes('html') ? htmlToText(r.body) : r.body;
        return okResult(
          {
            url: current,
            finalUrl: current,
            status: r.res.status,
            contentType: ct,
            title: ct.toLowerCase().includes('html') ? extractTitle(r.body) : undefined,
            text,
            bytes: r.bytes,
            truncated: r.truncated,
          },
          Date.now() - started,
          r.truncated,
        );
      }
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? '请求超时' : (e as Error).message;
      return errResult('NETWORK_ERROR', `获取页面失败: ${msg}`, Date.now() - started);
    }
  },
};
