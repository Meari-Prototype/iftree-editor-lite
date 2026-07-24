import { type ElementType, type ReactNode, useMemo } from 'react';

import { renderTexMathToText } from '../../core/markdown.js';
import { ADDRESS_CANDIDATE_PATTERN, isAddressCandidate } from '../../core/address-link.js';
import { parseRichMarkdown, richMarkdownImageSources, type RichBlock, type RichInline } from '../../core/rich-markdown.js';
import { useResolvedImageSourcesForSources } from '../hooks/useResolvedImages.js';
import { getUiMessages, useUiLanguage } from '../../lang/ui.js';

// 无版面格式（md / txt / 节点正文 / agent 文本）统一的富文本渲染组件。
// 解析走 core/rich-markdown（值型、全块型），这里只把值型 block 映射成 React。
// 代码高亮 / 链接打开等增强后续补；当前先把结构正确铺出来。

// 节点地址内联链接（agent 回答 → 节点定位）：可选能力，调用方提供 resolve（判定地址
// 在目标文档真实存在）与 onLocate（点击定位）。不传时渲染行为与之前完全一致。
// 只有 resolve 判定存在的地址才渲染成链接——1-2-18674 这种不存在的地址、100-300 这种
// 区间表达，都会因为查无此节点而自然保持纯文本。纯渲染层解析，不碰消息内容本身。
export interface AddressLinkHandlers {
  resolve: (address: string) => boolean;
  onLocate: (address: string) => void;
}

interface RichMarkdownProps {
  markdown?: unknown;
  docId?: string | null;
  className?: string;
  addressLinks?: AddressLinkHandlers | null;
}

type ResolveSrc = (src: string) => string;

export function RichMarkdown({ markdown = '', docId = null, className = '', addressLinks = null }: RichMarkdownProps) {
  useUiLanguage();
  const blocks = useMemo(() => parseRichMarkdown(markdown), [markdown]);
  const imageSources = useMemo(() => richMarkdownImageSources(blocks), [blocks]);
  const resolvedImages = useResolvedImageSourcesForSources(imageSources, docId);
  const resolveSrc = (src: string) => resolvedImages[src] || src;
  return (
    <div className={`rich-markdown${className ? ` ${className}` : ''}`}>
      {blocks.map((block, index) => <RichBlockView key={index} block={block} resolveSrc={resolveSrc} addressLinks={addressLinks} />)}
    </div>
  );
}

function RichBlockView({ block, resolveSrc, addressLinks }: { block: RichBlock; resolveSrc: ResolveSrc; addressLinks?: AddressLinkHandlers | null }) {
  if (block.type === 'heading') {
    const Tag = (`h${block.level}`) as ElementType;
    return <Tag>{renderInlineTokens(block.inline, resolveSrc, addressLinks)}</Tag>;
  }
  if (block.type === 'paragraph') {
    return <p>{renderInlineTokens(block.inline, resolveSrc, addressLinks)}</p>;
  }
  if (block.type === 'blockquote') {
    return <blockquote>{renderInlineTokens(block.inline, resolveSrc, addressLinks)}</blockquote>;
  }
  if (block.type === 'list') {
    const Tag = (block.ordered ? 'ol' : 'ul') as ElementType;
    return (
      <Tag>
        {(block.items || []).map((item, index) => <li key={index}>{renderInlineTokens(item.inline, resolveSrc, addressLinks)}</li>)}
      </Tag>
    );
  }
  if (block.type === 'table') {
    return (
      <div className="rich-markdown-table-wrap">
        <table>
          {block.header && (
            <thead>
              <tr>{block.header.map((cell, index) => <th key={index}>{renderInlineTokens(cell, resolveSrc, addressLinks)}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {(block.rows || []).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => <td key={cellIndex}>{renderInlineTokens(cell, resolveSrc, addressLinks)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === 'code') {
    return (
      <pre className="rich-markdown-code">
        <code data-language={block.language || undefined}>{block.text}</code>
      </pre>
    );
  }
  if (block.type === 'math') {
    return <div className="rich-markdown-math">{renderTexMathToText(block.text)}</div>;
  }
  if (block.type === 'image') {
    return (
      <figure className="rich-markdown-figure">
        <img src={resolveSrc(block.src || '')} alt={block.alt} />
        {block.alt ? <figcaption>{block.alt}</figcaption> : null}
      </figure>
    );
  }
  return null;
}

export function renderInlineTokens(
  tokens: RichInline[] | null | undefined,
  resolveSrc: ResolveSrc | null = null,
  addressLinks: AddressLinkHandlers | null = null
) {
  return (tokens || []).map((token, index) => renderInlineToken(token, index, resolveSrc, addressLinks));
}

function renderInlineToken(
  token: RichInline | null | undefined,
  key: number,
  resolveSrc: ResolveSrc | null,
  addressLinks: AddressLinkHandlers | null
) {
  if (!token) return null;
  if (token.type === 'strong') return <strong key={key}>{renderTextWithAddressLinks(token.text, addressLinks, `s${key}`)}</strong>;
  if (token.type === 'em') return <em key={key}>{renderTextWithAddressLinks(token.text, addressLinks, `e${key}`)}</em>;
  if (token.type === 'code') return <code key={key}>{token.text}</code>;
  if (token.type === 'math') return <span key={key} className="math-inline">{renderTexMathToText(token.text)}</span>;
  if (token.type === 'link') {
    // 链接先不跳转（与源文档视图一致；Electron 内打开外链的行为留到 agent 阶段按需接 window-service）。
    return (
      <a key={key} href={token.href || '#'} onClick={(event) => event.preventDefault()}>
        {token.text}
      </a>
    );
  }
  if (token.type === 'image') {
    return <img key={key} className="rich-markdown-inline-image" src={resolveSrc ? resolveSrc(token.src as string) : token.src} alt={token.alt || ''} />;
  }
  return <span key={key}>{renderTextWithAddressLinks(token.text || '', addressLinks, `t${key}`)}</span>;
}

// 把一段纯文本里的地址候选切成「文本 + 链接」序列：只有 resolve 判定真实存在的地址
// 才包成 <a>，其余（含查无此节点的候选）原样保留为文本。code/math/link/image 分支
// 不走这里——行内代码与已有链接绝不嵌套地址链接。
function renderTextWithAddressLinks(text: unknown, addressLinks: AddressLinkHandlers | null | undefined, keyPrefix: string): ReactNode {
  const source = String(text || '');
  if (!addressLinks) return source;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  for (const match of source.matchAll(ADDRESS_CANDIDATE_PATTERN)) {
    const address = match[0];
    const start = match.index ?? 0;
    if (start < lastIndex) continue;
    if (!isAddressCandidate(address) || !addressLinks.resolve(address)) continue;
    if (start > lastIndex) parts.push(source.slice(lastIndex, start));
    parts.push(
      <a
        key={`${keyPrefix}-${start}`}
        className="rich-md-address"
        href={`#node-${address}`}
        title={getUiMessages().common.locateNodeAt(address)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          addressLinks.onLocate(address);
        }}
      >
        {address}
      </a>
    );
    lastIndex = start + address.length;
  }
  if (parts.length === 0) return source;
  if (lastIndex < source.length) parts.push(source.slice(lastIndex));
  return parts;
}
