// src/tools/research/ssrf.ts — SSRF / 危险目标防护（纯函数，便于测试）
// 阻止：非 http/https、localhost、回环/未指定地址、私网地址段、
//       云元数据地址（169.254.169.254）、内网域名，以及不在白名单的域名。

import { URL } from 'node:url';
import { isIP } from 'node:net';

/** 回环地址（允许被「测试连接」这类本地工具使用） */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;
  const m = h.match(/^127\.(\d+)\.(\d+)\.(\d+)$/);
  return !!m;
}

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

export function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  if (p[0] === 127) return true; // 回环
  if (p[0] === 10) return true; // 10/8
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16/12
  if (p[0] === 192 && p[1] === 168) return true; // 192.168/16
  if (p[0] === 169 && p[1] === 254) return true; // 169.254/16 链路本地 / 云元数据
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // 100.64/10 CGNAT
  if (p[0] === 0) return true; // 0.0.0.0/8
  return false;
}

export function isPrivateV6(ip: string): boolean {
  const a = ip.toLowerCase();
  if (a === '::1' || a === '::') return true;
  if (a.startsWith('fe80')) return true; // 链路本地
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // 唯一本地 fc00::/7
  // IPv4 映射地址 ::ffff:a.b.c.d
  const m = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
  if (m) return isPrivateV4(m[1]);
  return false;
}

export function checkUrl(raw: string, allowedDomains?: string[]): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL 非法' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `不允许的协议: ${u.protocol}` };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'localhost 被禁止' };
  }
  if (host.endsWith('.internal') || host === 'metadata.google.internal') {
    return { ok: false, reason: '内网域名被禁止' };
  }
  if (host.includes('169.254.169.254')) {
    return { ok: false, reason: '云元数据地址被禁止' };
  }
  const ipVer = isIP(host);
  if (ipVer === 4 && isPrivateV4(host)) return { ok: false, reason: `私网 IPv4 被禁止: ${host}` };
  if (ipVer === 6 && isPrivateV6(host)) return { ok: false, reason: `私网 IPv6 被禁止: ${host}` };

  if (allowedDomains && allowedDomains.length) {
    const ok = allowedDomains.some((d) => {
      const dd = d.toLowerCase();
      return host === dd || host.endsWith('.' + dd);
    });
    if (!ok) return { ok: false, reason: `域名不在白名单: ${host}` };
  }
  return { ok: true };
}
