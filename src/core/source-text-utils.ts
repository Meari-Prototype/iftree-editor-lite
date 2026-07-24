import { readFileSync } from 'node:fs';

export function readTextFile(filePath: string): string {
  const buffer = readFileSync(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le');
  }
  // UTF-16 BE BOM（0xFE 0xFF）：与 LE 对称处理，否则落入 detectTextCharset 按
  // utf8/gb18030 解码出交错 NUL 乱码（source-epub 的 decodeEntry 已同处理 LE/BE）。
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  }
  const charset = detectTextCharset(buffer);
  return decodeBuffer(buffer, charset).replace(/^﻿/, '');
}

function detectTextCharset(buffer: Buffer): string {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('ascii');
  const meta = head.match(/charset\s*=\s*["']?([a-z0-9._-]+)/i);
  if (meta) return normalizeCharset(meta[1]);
  const utf8 = buffer.toString('utf8');
  const replacementCount = (utf8.match(/�/g) || []).length;
  return replacementCount > Math.max(2, utf8.length * 0.01) ? 'gb18030' : 'utf-8';
}

function normalizeCharset(value: unknown): string {
  const normalized = String(value || '').toLowerCase();
  if (['gb2312', 'gbk', 'gb18030'].includes(normalized)) return 'gb18030';
  if (['shift_jis', 'sjis', 'cp932'].includes(normalized)) return 'shift_jis';
  return normalized || 'utf-8';
}

function decodeBuffer(buffer: Buffer, charset: unknown): string {
  try {
    return new TextDecoder(String(charset || 'utf-8')).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

export function attr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return match ? match[1] : null;
}

// 数值字符引用按码点解码；超 Unicode 范围（>0x10FFFF）或孤值时 fromCodePoint 抛
// RangeError——损坏/手工构造文件里的 &#x110000; 等不应让整篇导入中断，回落为 U+FFFD。
export function codePointToStringSafe(codePoint: number): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : '�';
}

export function decodeXmlEntities(value: unknown): string {
  return String(value)
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => codePointToStringSafe(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => codePointToStringSafe(Number.parseInt(code, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function xmlUnescape(value: unknown): string {
  return decodeXmlEntities(value);
}