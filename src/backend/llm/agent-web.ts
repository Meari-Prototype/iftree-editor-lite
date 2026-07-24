// 内置 agent web_search 工具的安全闸与结果解析（agent-runtime 拆分，§6-7）：
// 内网/保留地址拦截（SSRF 防护）、DNS/连接钉扎、HTML 实体解码、DuckDuckGo 结果页解析。
import { lookup } from 'node:dns/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

const AGENT_WEB_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const AGENT_WEB_MAX_REDIRECTS = 20;

interface AgentWebRequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal | null;
}

export interface AgentWebTextResponse {
  url: string;
  status: number;
  statusText: string;
  text: string;
}

export function blockedIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

export function blockedIpv6(hostname: string): boolean {
  const text = hostname.toLowerCase();
  if (text === '::1' || text === '::') return true;
  if (text.startsWith('fe80:') || text.startsWith('fc') || text.startsWith('fd')) return true;
  if (text.startsWith('::ffff:')) {
    const mapped = text.slice('::ffff:'.length);
    return isIP(mapped) === 4 ? blockedIpv4(mapped) : true;
  }
  return false;
}

export function assertAgentOpenUrlAllowed(rawUrl: unknown): string {
  let url: URL;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('web_search open 需要合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('web_search open 只允许 http 或 https URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname) throw new Error('web_search open 需要 URL 主机名');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('web_search open 禁止访问 localhost');
  }
  if (!hostname.includes('.') && isIP(hostname) === 0) {
    throw new Error('web_search open 禁止访问内网短主机名');
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && blockedIpv4(hostname)) throw new Error('web_search open 禁止访问内网或保留 IPv4 地址');
  if (ipVersion === 6 && blockedIpv6(hostname)) throw new Error('web_search open 禁止访问内网或保留 IPv6 地址');
  return url.toString();
}

export function assertAgentResolvedAddressAllowed(rawAddress: unknown): void {
  const address = String(rawAddress || '').trim().replace(/^\[|\]$/g, '');
  const ipVersion = isIP(address);
  if (ipVersion === 4 && blockedIpv4(address)) {
    throw new Error('web_search open DNS 解析到内网或保留 IPv4 地址');
  }
  if (ipVersion === 6 && blockedIpv6(address)) {
    throw new Error('web_search open DNS 解析到内网或保留 IPv6 地址');
  }
  if (ipVersion === 0) throw new Error('web_search open DNS 返回了无效 IP 地址');
}

interface ResolvedAddress {
  address: string;
  family: number;
}

async function resolveAgentWebAddress(url: URL, signal?: AbortSignal | null): Promise<ResolvedAddress> {
  signal?.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const ipVersion = isIP(hostname);
  const addresses = ipVersion > 0
    ? [{ address: hostname, family: ipVersion }]
    : await lookup(hostname, { all: true, verbatim: true });
  signal?.throwIfAborted();
  if (addresses.length === 0) throw new Error('web_search open DNS 未返回可用地址');
  for (const resolved of addresses) assertAgentResolvedAddressAllowed(resolved.address);
  return addresses[0];
}

interface AgentWebHop {
  status: number;
  statusText: string;
  location: string;
  text: string;
}

function requestAgentWebHop(
  url: URL,
  resolved: ResolvedAddress,
  options: AgentWebRequestOptions
): Promise<AgentWebHop> {
  const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [{ address: resolved.address, family: resolved.family }]);
    else callback(null, resolved.address, resolved.family);
  };
  const request = url.protocol === 'https:' ? requestHttps : requestHttp;
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: 'GET',
      headers: options.headers,
      lookup: pinnedLookup,
      agent: false,
      signal: options.signal || undefined
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        statusText: response.statusMessage || '',
        location: response.headers.location || '',
        text: Buffer.concat(chunks).toString('utf8')
      }));
      response.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

export async function fetchAgentWebText(
  rawUrl: unknown,
  options: AgentWebRequestOptions = {}
): Promise<AgentWebTextResponse> {
  let currentUrl = assertAgentOpenUrlAllowed(rawUrl);
  const visited = new Set<string>();
  for (let redirectCount = 0; redirectCount <= AGENT_WEB_MAX_REDIRECTS; redirectCount += 1) {
    options.signal?.throwIfAborted();
    if (visited.has(currentUrl)) throw new Error('web_search open 检测到重定向循环');
    visited.add(currentUrl);
    const url = new URL(currentUrl);
    const resolved = await resolveAgentWebAddress(url, options.signal);
    const response = await requestAgentWebHop(url, resolved, options);
    if (!AGENT_WEB_REDIRECT_STATUSES.has(response.status)) {
      return {
        url: currentUrl,
        status: response.status,
        statusText: response.statusText,
        text: response.text
      };
    }
    if (!response.location) throw new Error('web_search open 重定向缺少 Location');
    if (redirectCount === AGENT_WEB_MAX_REDIRECTS) {
      throw new Error(`web_search open 重定向次数超过 ${AGENT_WEB_MAX_REDIRECTS}`);
    }
    currentUrl = assertAgentOpenUrlAllowed(new URL(response.location, url).toString());
  }
  throw new Error(`web_search open 重定向次数超过 ${AGENT_WEB_MAX_REDIRECTS}`);
}

export function decodeHtmlEntities(value: unknown = ''): string {
  // 数字实体（&#92; / &#x27; 等）是封闭规则，用两条带回调的 replace 全覆盖、不逐个枚举；
  // 非法码点回退原文（|| m）防 RangeError。&amp; 放最后解，避免把已解出的 & 再当实体头。
  const fromCp = (cp: number): string => (Number.isFinite(cp) && cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '');
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => fromCp(parseInt(hex, 16)) || m)
    .replace(/&#(\d+);/g, (m, dec) => fromCp(parseInt(dec, 10)) || m)
    .replace(/&amp;/g, '&');
}

export function stripHtml(value: unknown = ''): string {
  return decodeHtmlEntities(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

export function normalizeDuckDuckGoUrl(raw: unknown = ''): string {
  const text = decodeHtmlEntities(raw);
  try {
    const parsed = new URL(text, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    return uddg || parsed.href;
  } catch {
    return text;
  }
}

export interface DuckDuckGoResult {
  title: string;
  url: string;
  snippet: string;
}

export function parseDuckDuckGoResults(html: unknown, limit: number): DuckDuckGoResult[] {
  const results: DuckDuckGoResult[] = [];
  const blocks = String(html || '').split(/<div class="result results_links[^>]*>/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    const url = normalizeDuckDuckGoUrl(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: stripHtml(link[2]),
      url,
      snippet: stripHtml(snippet?.[1] || '')
    });
    if (results.length >= limit) break;
  }
  return results;
}
