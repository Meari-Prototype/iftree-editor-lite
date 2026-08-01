#!/usr/bin/env node
// MCP entry (projectneed `18`): official MCP SDK thin shell over the headless
// backend. Exposes the retrieval channel (db.shell / database.read) and the
// A2A channel (agent.run -> built-in agent). The shell itself touches no native
// module; it delegates to the headless host. The host ALWAYS runs on a real node
// runtime (node ABI): resolveNodeExecutable (in backend-client) pins it regardless
// of whether this shell was launched by node or electron — so better-sqlite3 only
// ever needs its node-ABI build, and the host can't inherit an Electron ABI.
// Recommended launch: node dist/src/mcp/mcp-server.js (npm run mcp:node).
// npm run mcp retains an Electron launcher, but the backend still uses node ABI.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createBackendClient } from '../backend/llm/backend-client.js';
import { backendDescriptorPath, resolveBackendDbPath, removeBackendDescriptorIfOwn } from '../backend/llm/backend-discovery.js';
import { applyDotEnvToProcessEnv } from '../backend/llm/settings.js';
import { NODE_TYPES, NODE_TYPE_LABELS } from '../core/node-model.js';

// 本模块产物住 dist/src/mcp/，项目根在三级之上。
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// mcp-server 是独立后端进程：父进程直接读 process.env 的变量（嵌入后端 IFTREE_EMBED_*、
// agent 超时 IFTREE_AGENT_TIMEOUT_MS 等）此前吃不到项目根 .env——只填未显式设置的键，
// 与 headless host 内灌入同一语义（不覆盖外部注入）。
applyDotEnvToProcessEnv(join(PROJECT_ROOT, '.env'));
// doc/node/commit(历史)/ref 标识统一为 UUID v7 字符串；整数 id 已退役（save_history 退役后不再有整数历史 id）。
const docIdSchema = z.string().min(1);

// MCP SDK 的 ToolCallback<InputArgs> 应该会从 inputSchema 推 callback args 类型，但 strict 下实测推断常退化为
// any——本文件每个 callback 显式 annotate args 形参，按「原子 Arg 接口 + 工具专属字段 inline 组合」组装：
// 原子接口（DocId / Address / Uuid / At / Limit / Json / Owner / BranchTarget / DraftSummary）收公共字段，
// 工具专属字段在交叉类型里 inline 列出。所有字段除显式必填外一律 optional——MCP 调用方传什么由 inputSchema 卡。

type DocId = string;
type ToolTextResult = { content: Array<{ type: 'text'; text: string }> };
type BackendClient = ReturnType<typeof createBackendClient>;

interface DocIdArg { docId: DocId }
interface DocIdOptionalArg { docId?: DocId }
interface AddressArg { address?: string; nodeId?: DocId }
interface UuidArg { uuid?: boolean }
interface AtArg { at?: DocId | string; atAddress?: boolean }
interface LimitArg { limit?: number }
interface JsonArg { json?: boolean }
interface DraftSummaryArg {
  summary?: string;
  tag?: string;
}

const nodeTypeContractText = `节点类型统一写 node_type/nodeType，不再使用 human_tag。内部码：${NODE_TYPES.join(', ')}；中文标签：${Object.values(NODE_TYPE_LABELS).join(' / ')}。`;

// Permission tier picked at launch by the deployment. yolo 是 human 的俗称别名。
const RAW_TIER = (process.env.IFTREE_MCP_TIER || 'read').toLowerCase();
const TIER = RAW_TIER === 'yolo' ? 'human' : RAW_TIER;
const IS_WRITE_TIER = TIER === 'edit' || TIER === 'full' || TIER === 'human';
// switch 选中的当前默认文档（进程内）。草稿相关动词未显式给 docId 时使用它。
let selectedDocId: DocId | null = null;

function textResult(text: unknown): ToolTextResult {
  return { content: [{ type: 'text', text: String(text ?? '') }] };
}

// 文本回执单一调用点（A2-1 / §6-6）：MCP 各动词一律转发对应 db-shell 动词，人读文本与
// 结构化 --json 都在 backend 渲染（write-result-text/diff-text）；本文件只做入口适配。
async function dbShell(client: BackendClient, argv: string[], currentDocId?: DocId | null): Promise<string> {
  const agentMode = TIER === 'read' ? 'qa' : TIER === 'edit' ? 'edit' : 'full';
  const res = await client.dbShell(argv, { currentDocId, agentMode }) as { text?: unknown } | null;
  return res?.text != null ? String(res.text) : '';
}

function registerRetrievalTools(server: McpServer, client: BackendClient) {
  server.registerTool('library_index', {
    description: '按 library 文件夹包含层级列出已导入文档的 ASCII tree；默认文件节点显示文件名、字数和语义状态，不显示 UUID；uuid=true 时附 #docId。未导入文件不列出；(xxx字) 是该文档节点 1 的整棵子树正文合计，不是节点 1 自有正文。默认不显示摘要，includeSummary=true 时才附加摘要内容。',
    inputSchema: {
      folder: z.string().optional().describe('可选 library 相对文件夹路径；省略时从 library 根列出。'),
      includeSummary: z.boolean().optional().describe('默认 false；true 时附加摘要内容。字数仍表示整棵子树正文合计，不是节点自有正文。'),
      includeHidden: z.boolean().optional().describe('默认 false：忽略 . 开头隐藏文件夹。true 时一并列出。'),
      uuid: z.boolean().optional().describe('true 时显示 #docId；默认 false，只显示文件名作为文档标签。')
    }
  }, async ({ folder, includeSummary, includeHidden, uuid }: { folder?: string; includeSummary?: boolean; includeHidden?: boolean } & UuidArg = {}) => {
    const argv = ['index'];
    if (folder) argv.push('--folder', String(folder));
    if (includeSummary) argv.push('--summary');
    if (includeHidden) argv.push('--include-hidden');
    if (uuid) argv.push('--uuid');
    return textResult((await dbShell(client, argv)) || '(库里暂无已导入文档)');
  });

  server.registerTool('tree', {
    description: '查看文档结构（缩进 ASCII 树：地址 类型 标题 (子树字数)）。可选 address 只看某子树，depth 限层。地址形如 1、1-3、1-3-2，是相对地址。注意字数是整棵子树合计，不是该节点自有正文。',
    inputSchema: {
      docId: docIdSchema.describe('已导入文档的 doc id。'),
      address: z.string().optional().describe('可选节点地址；省略时从节点 1 展开。输出中的字数是该地址节点的子树合计。'),
      nodeId: docIdSchema.optional().describe('可选节点稳定 UUID：兼容定位入口，给了即从该节点子树展开（优先于 address）。'),
      depth: z.number().int().positive().optional().describe('可选展开层数；输出中的 (xxx) 仍是各节点整棵子树合计，不是节点自有正文。'),
      at: z.union([docIdSchema, z.string()]).optional().describe('可选历史 ref（commit id/committed_at/summary tag）：看该版本的结构快照。给 address 时默认按节点身份穿透（当前 address→node_id，节点换过地址也认得）。'),
      atAddress: z.boolean().optional().describe('与 at 配合：true 时按历史地址定位（git <commit>:<path> 语义，查已删节点/某版本某位置）；默认按当前节点身份穿透。'),
      uuid: z.boolean().optional().describe('true 时保留稳定 id；默认 false。')
    }
  }, async ({ docId, address, depth, at, atAddress, uuid, nodeId }: DocIdArg & AddressArg & AtArg & UuidArg & { depth?: number }) => {
    const argv = ['tree', String(docId)];
    if (address) argv.push(address);
    if (nodeId) argv.push('--node-id', String(nodeId));
    if (depth) argv.push('--depth', String(depth));
    if (at !== undefined) argv.push('--at', String(at));
    if (atAddress) argv.push('--at-address');
    if (uuid) argv.push('--uuid');
    return textResult((await dbShell(client, argv)) || '(空)');
  });

  server.registerTool('read', {
    description: '读取文档某地址的正文，只回正文、不带节点头。scope 选范围：subtree(默认，整棵子树正文拼接)/node(只本节点)/siblings(同父前中后三条)。必须定位到具体节点：address 传到小节（如 1-1、1-3-2）或给 nodeId——本系统的文档是检索定位用的、不是从头通读，直读根地址 1（=整篇）是反常用法，正常连读开头都该传 1-1。子树正文有 1 万字门禁（超了分层早停、只返回前几层并提示），要完整读大段得显式加大 limit 二次突破。全篇结构用 tree、定长原文窗口用 article、元信息/出处/引用用 inspect；历史版本传 at。命中过碎时读父地址或相邻地址补上下文。',
    inputSchema: {
      docId: docIdSchema,
      address: z.string().optional().describe('节点地址(如 1-3-2)：主定位方式；与 nodeId 二选一，二者皆给时以 nodeId 为准。'),
      nodeId: docIdSchema.optional().describe('节点稳定 UUID：兼容定位入口，可传 inspect / log·diff / 引用括号 拿到的 node_id 直接读，免去先换算地址；address 仍是主路径（find 命中只给地址、不输出 node_id，要 node_id 用 inspect 单节点取）。'),
      scope: z.enum(['node', 'subtree', 'siblings']).optional().describe('读取范围：subtree 整棵子树正文拼接(默认)/node 只本节点/siblings 同父前中后三条。'),
      at: z.union([docIdSchema, z.string()]).optional().describe('可选历史 ref：commit id（UUID）、committed_at 或 summary tag；只读历史快照。默认按节点身份穿透（当前 address→node_id，节点换过地址也认得；不在该版本则报错，而非静默命中同址别的节点）。'),
      atAddress: z.boolean().optional().describe('与 at 配合：true 时按历史地址定位（git <commit>:<path> 语义，查已删节点/某版本某位置）；默认按当前节点身份穿透。'),
      limit: z.number().int().positive().optional().describe('子树正文字数门禁；默认 1 万字（分层早停、超了只返回前几层）。要完整读大子树就显式加大它——这是突破门禁的二次确认。'),
      uuid: z.boolean().optional().describe('true 时头部显示 doc:UUID；默认显示文档标签。')
    }
  }, async ({ docId, address, scope, at, atAddress, limit, uuid, nodeId }: DocIdArg & AddressArg & AtArg & LimitArg & UuidArg & { scope?: 'node' | 'subtree' | 'siblings' }) => {
    if (!address && !nodeId) {
      return textResult('read 要先定位到具体节点：传 address（正常到小节，如 1-1、1-3-2）或 nodeId。本系统的文档是检索定位用的、不是从头通读——直读根地址 1 等于拉整篇，是反常用法（连读开头都该传 1-1）；先用 tree 看结构，挑要读的小节再 read。');
    }
    const argv = ['read', String(docId)];
    if (address) argv.push(String(address));
    if (scope) argv.push('--range', String(scope));
    if (nodeId) argv.push('--node-id', String(nodeId));
    if (at !== undefined) argv.push('--at', String(at));
    if (atAddress) argv.push('--at-address');
    if (limit) argv.push('--limit', String(limit));
    if (uuid) argv.push('--uuid');
    return textResult(await dbShell(client, argv));
  });

  server.registerTool('inspect', {
    description: '节点/文档档案：身份段(doc/地址/类型/信任/标题) + 选取的附加段。sections 逗号分隔选 meta(updated/created/sort/hash)、source(原文出处+spans，原 blame)、links(引用进出)、note(备注)；默认 meta,note。读正文用 read、原文窗口用 article。',
    inputSchema: {
      docId: docIdSchema,
      address: z.string().optional().describe('节点地址(如 1-3-2)：主定位方式；与 nodeId 二选一，二者皆给时以 nodeId 为准。'),
      nodeId: docIdSchema.optional().describe('节点稳定 UUID：兼容定位入口，可直接传 inspect / log·diff / 引用 拿到的 node_id；address 仍是主路径（find 不输出 node_id）。'),
      sections: z.string().optional().describe('逗号分隔选段：meta,source,links,note；默认 meta,note。'),
      limit: z.number().int().positive().optional(),
      uuid: z.boolean().optional().describe('true 时身份行显示 doc:UUID；默认显示文档标签。')
    }
  }, async ({ docId, address, sections, limit, uuid, nodeId }: DocIdArg & AddressArg & LimitArg & UuidArg & { sections?: string }) => {
    if (!address && !nodeId) return textResult('inspect 需要 address 或 nodeId 之一。');
    const argv = ['inspect', String(docId)];
    if (address) argv.push(String(address));
    if (sections) argv.push('--sections', String(sections));
    if (nodeId) argv.push('--node-id', String(nodeId));
    if (limit) argv.push('--limit', String(limit));
    if (uuid) argv.push('--uuid');
    return textResult(await dbShell(client, argv));
  });

  server.registerTool('find', {
    description: '统一检索动词。默认用 terms 做多词 AND 字面检索；semantic=true 时用 query 做语义检索并在命中行追加 score；entity=true 时检索实体库（无 terms 列全部实体，有 terms 返同义/相关列表，加 expand=true 时用同义组扩展后做字面检索返节点）。命中行输出 文档标签/address/type/title；uuid=true 时文档标签换成 doc:UUID。命中只用于挑候选，回答前用 read 取回正文证据。',
    inputSchema: {
      terms: z.array(z.string()).min(1).optional().describe('字面检索词；semantic=false 时必填（entity=true 时可省略以列全部实体），多词按 AND 精确匹配。'),
      query: z.string().optional().describe('semantic=true 时的自然语言查询。'),
      semantic: z.boolean().optional().describe('true 时走语义检索；需目标文档已建立向量索引。'),
      entity: z.boolean().optional().describe('true 时走实体检索：无 terms 列当前文档全部实体；有 terms 返同义/相关实体列表；配合 expand=true 时用同义组扩展后做字面检索返节点。实体按文档存储，仍需配合 docId/allDocs/folder 圈定范围。'),
      expand: z.boolean().optional().describe('仅在 entity=true 时有效：用同义组扩展 terms 后做字面检索，返回节点列表而非实体列表。多词保持 AND 框架，每个词的同义组内 OR。'),
      docId: docIdSchema.optional().describe('限定单篇文档；与 allDocs 二选一。'),
      allDocs: z.boolean().optional().describe('true 时跨所有已导入文档检索；与 docId 二选一。'),
      scopeAddress: z.string().optional().describe('可选局部节点地址；需要同时给 docId。'),
      limit: z.number().int().positive().optional().describe('可选返回数量上限。'),
      matchMode: z.enum(['doc', 'node', 'or']).optional().describe('字面检索匹配模式：doc=文档级AND(默认,高命中,词可分散在同文档不同节点)、node=节点级AND(精确同节点共现)、or=任一词命中。'),
      trust: z.string().optional().describe('按信任层过滤(逗号分隔)：受控 / 不受控。'),
      since: z.string().optional().describe('只返回 updated_at ≥ 此时间(ISO 8601)的节点。'),
      until: z.string().optional().describe('只返回 updated_at ≤ 此时间(ISO 8601)的节点。'),
      at: z.union([docIdSchema, z.string()]).optional().describe('可选历史 ref（commit id/committed_at/summary tag）：在该版本快照上做字面检索（仅单篇、不支持 semantic/entity/跨文档）。'),
      folder: z.string().optional().describe('按 library 文件夹子树限定跨文档检索范围（= 检索该文件夹这篇大型虚拟文档），如 generated 或 testtext/无限规则test；folder 本身即跨文档，无需再给 allDocs。有哪些文件夹用 library_index（导航虚拟文档）查。'),
      excludeFolder: z.string().optional().describe('从跨文档检索中排除这些 library 文件夹子树（逗号分隔多个）；可单独用（= 整库减去这些子树）。文件夹路径同样用 library_index 查。'),
      labels: z.boolean().optional().describe('true 时命中按节点标信任(受控/不受控/null=导入未标注，按不受控对待)，便于分信任挑候选；默认 false 不输出这些以保持精简。'),
      uuid: z.boolean().optional().describe('true 时命中行显示 doc:UUID；默认 false，显示文档标签。'),
      includeHidden: z.boolean().optional().describe('默认 false：跨文档检索排除 . 开头隐藏路径文件夹；true 时把隐藏路径一并纳入。'),
      minScore: z.number().optional().describe('过滤阈值（高级搜索）：语义检索按相似度下限，默认 0.51（过滤 sim < 0.51 的弱相关）；字面检索按命中次数下限（hit < 阈值则过滤），默认不限。')
    }
  }, async ({ terms, query, semantic, entity, expand, docId, allDocs, scopeAddress, limit, matchMode, trust, since, until, at, folder, excludeFolder, labels, uuid, includeHidden, minScore }: DocIdOptionalArg & AtArg & LimitArg & UuidArg & {
    terms?: string[]; query?: string; semantic?: boolean; entity?: boolean; expand?: boolean;
    allDocs?: boolean; scopeAddress?: string; matchMode?: 'doc' | 'node' | 'or';
    trust?: string;
    since?: string; until?: string; folder?: string; excludeFolder?: string;
    labels?: boolean; includeHidden?: boolean; minScore?: number;
  } = {}) => {
    const folderScope = Boolean(folder) || Boolean(excludeFolder);
    if (docId && allDocs) return textResult('docId 和 allDocs 只能二选一。');
    if (docId && folderScope) return textResult('docId 与 folder/excludeFolder 不能同用（folder 已是跨文档范围）。');
    if (!docId && !allDocs && !folderScope) {
      return textResult(entity
        ? '请给 docId 限定单篇，或用 allDocs / folder 跨文档检索。实体按文档存储，同样要先圈定范围。'
        : '请给 docId 限定单篇，或用 allDocs / folder 跨文档检索。');
    }
    if (scopeAddress && !docId) return textResult('scopeAddress 需要同时给 docId。');
    if (semantic && entity) return textResult('semantic 和 entity 不能同时为 true。');
    if (expand && !entity) return textResult('expand 需要配合 entity=true 使用。');
    if (semantic && folderScope) return textResult('folder/excludeFolder 暂只支持字面检索，不支持 semantic（语义范围过滤待接入）。');

    const argv = ['find'];
    if (semantic) argv.push('--semantic');
    if (entity) argv.push('--entity');
    if (expand) argv.push('--expand');
    if (allDocs || folderScope) argv.push('--all-docs');
    if (folder) argv.push('--folder', String(folder));
    if (excludeFolder) argv.push('--exclude-folder', String(excludeFolder));
    if (scopeAddress) argv.push('--scope', String(docId), scopeAddress);
    if (limit) argv.push('--limit', String(limit));
    if (minScore !== undefined) argv.push('--min-score', String(minScore));
    if (at !== undefined) argv.push('--at', String(at));
    if (matchMode) argv.push('--match-mode', String(matchMode));
    if (trust) argv.push('--trust', String(trust));
    if (since) argv.push('--since', String(since));
    if (until) argv.push('--until', String(until));
    if (labels) argv.push('--labels');
    if (uuid) argv.push('--uuid');
    if (includeHidden) argv.push('--include-hidden');
    if (semantic) {
      const text = String(query || '').trim();
      if (!text) return textResult('semantic=true 时请给 query。');
      argv.push(text);
    } else {
      const safeTerms = Array.isArray(terms) ? terms.map((term) => String(term).trim()).filter(Boolean) : [];
      if (safeTerms.length === 0 && !entity) return textResult('请给 terms（entity=true 时可省略以列全部实体）。');
      argv.push(...safeTerms);
    }
    try {
      return textResult((await dbShell(client, argv, allDocs || folderScope || scopeAddress ? undefined : docId)) || '(无命中)');
    } catch (error) {
      return textResult(`find 当前不能执行：${(error as { message?: string } | null | undefined)?.message || error}\n降级：用 find 的 terms 字面检索 + tree 结构定位。`);
    }
  });

  server.registerTool('log', {
    description: '列出文档或某节点/子树的提交历史。不给 address 即整篇文档的 commit 史；给 address（如 1-3-2）则只列该地址子树被改动过的 commit。每行含 commit id、时间和摘要。',
    inputSchema: {
      docId: docIdSchema.describe('已导入文档的 doc id。'),
      address: z.string().optional().describe('可选节点地址（如 1-3-2）；给了即节点级 log，默认看整棵子树。'),
      nodeId: docIdSchema.optional().describe('可选节点稳定 UUID：兼容定位入口，给了即节点级 log（优先于 address）。'),
      node: z.boolean().optional().describe('true 时只看该地址节点自身、不含子树（需配合 address）。'),
      limit: z.number().int().positive().optional()
    }
  }, async ({ docId, address, node, limit, nodeId }: DocIdArg & AddressArg & LimitArg & { node?: boolean }) => {
    const argv = ['log', String(docId)];
    if (address) argv.push(String(address));
    if (nodeId) argv.push('--node-id', String(nodeId));
    if (node) argv.push('--node');
    if (limit) argv.push('--limit', String(limit));
    return textResult((await dbShell(client, argv)) || '(无历史)');
  });

  server.registerTool('diff', {
    description: '对比草稿与当前正文，或给出历史版本时对比两版历史。草稿模式只按 docId 定位；省略 docId 时使用 switch 当前文档。',
    inputSchema: {
      docId: docIdSchema.optional(),
      fromHistoryId: docIdSchema.optional(),
      toHistoryId: docIdSchema.optional(),
      historyId: docIdSchema.optional(),
      detail: z.enum(['summary', 'full']).optional(),
      json: z.boolean().optional(),
      from: z.string().optional().describe('head / commitId / draft / draft:docId'),
      to: z.string().optional().describe('取值同 from'),
      entity: z.boolean().optional()
    }
  }, async ({ docId, fromHistoryId, toHistoryId, historyId, json, detail, from, to, entity }: DocIdOptionalArg & JsonArg & {
    fromHistoryId?: DocId; toHistoryId?: DocId; historyId?: DocId;
    detail?: 'summary' | 'full'; from?: string; to?: string; entity?: boolean;
  } = {}) => {
    const targetDocId = docId ?? selectedDocId ?? undefined;
    const argv = ['diff'];
    const targetHistoryId = toHistoryId ?? historyId;
    if (targetDocId) argv.push(String(targetDocId));
    if (from !== undefined) argv.push('--from', String(from));
    if (to !== undefined) argv.push('--to', String(to));
    if (from === undefined && to === undefined && targetHistoryId) {
      if (!targetDocId) return textResult('diff 历史对比需要 docId。');
      if (fromHistoryId) argv.push(String(fromHistoryId));
      argv.push(String(targetHistoryId));
    } else if (from === undefined && to === undefined && !targetDocId) {
      return textResult('diff 需要 docId，或先 switch 到默认文档。');
    }
    if (entity) argv.push('--entity');
    if (detail) argv.push('--detail', String(detail));
    if (json) argv.push('--json');
    return textResult(await dbShell(client, argv));
  });

  server.registerTool('sql', {
    description: '只读 SQL 调试查询。只允许 SELECT/WITH，后端用 SQLite readonly 校验；用于核对数据库事实，不写入。'
      + ' 核心表(主键/常用列)：'
      + 'docs(id 主键=文档UUID, title, meta JSON含semantic状态, folder_id, updated_at)；'
      + 'nodes(id 主键=节点UUID, doc_id 外键, parent_id, address, node_type, text 正文, node_note, trust_level=受控|不受控, content_hash, subtree_hash, updated_at)；'
      + 'source_documents(doc_id 主键且=外键, source_type, original_path, raw_markdown；注意无 id 列)；'
      + 'doc_folders(id 主键 INTEGER, parent_id, name)；'
      + 'refs(id 主键, source_id, target_id, ref_kind；两端均为节点)；'
      + 'commits(id 主键=commitUUID, doc_id, parent_commit_id, committed_at, summary)；doc_heads(doc_id 主键, head_commit_id 指向当前)；'
      + 'edit_branches(id 主键 INTEGER, base_doc_id UNIQUE；行存在即该文档的活跃草稿)；'
      + 'entities(id 主键, doc_id, literal, normalized_literal) / entity_links / entity_node_bindings。'
      + ' 速记：文档=docs.id、节点正文=nodes.text；docs/nodes/commits 主键叫 id，source_documents 主键叫 doc_id。',
    inputSchema: {
      sql: z.string().describe('SELECT 或 WITH 开头的只读 SQL。'),
      params: z.union([z.array(z.any()), z.record(z.string(), z.any())]).optional().describe('可选 SQL 参数；数组对应 ? 参数，对象对应 @name 参数。'),
      limit: z.number().int().positive().optional().describe('可选返回行数上限；后端会限制最大值。'),
      json: z.boolean().optional().describe('true 时返回原始 JSON（行数组）；默认按行渲染紧凑文本。')
    }
  }, async ({ sql, params, limit, json }: LimitArg & JsonArg & { sql: string; params?: unknown[] | Record<string, unknown> }) => {
    const argv = ['sql', String(sql)];
    if (params !== undefined) argv.push('--params', JSON.stringify(params));
    if (limit !== undefined) argv.push('--limit', String(limit));
    if (json) argv.push('--json');
    return textResult(await dbShell(client, argv));
  });

  server.registerTool('article', {
    description: '读取导入文档的原文窗口。以锚点（startOffset 或 nodeId，都不给则文档开头）为基准取总长 limit 的窗口（默认 5000、上限 50000）。往前/往后自动分配：往前=min(⌊limit/5⌋,1000)、其余归往后（limit≤5000 时前后 1:4，更大时往前封顶 1000）；撞原文开头把往前余量并入往后、撞结尾则往前不补。触及原文首/尾时文本带 [原文开始]/[原文结束] 标记以区分自然到底与截断。可附 source spans。',
    inputSchema: {
      docId: docIdSchema.describe('已导入文档的 doc id。'),
      nodeId: docIdSchema.optional().describe('可选锚点节点 id；从该节点对应的原文位置取窗口。'),
      startOffset: z.number().int().nonnegative().optional().describe('可选原文锚点偏移；以它为中心取总长 limit 的窗口。不提供时用 nodeId 或文档开头。'),
      limit: z.number().int().positive().optional().describe('可选总窗口字符数；默认 5000，上限 50000（超过即报错，不静默截断）。'),
      before: z.number().int().nonnegative().optional().describe('可选往前字符数；不传按 min(⌊limit/5⌋,1000) 自动分配、传了覆盖；上限 50000（超过即报错）。'),
      spansLimit: z.number().int().positive().optional().describe('可选 source span 返回数量上限；默认 30。截断时文本模式标「窗口共 N」、json 模式给 spansTotal。'),
      includeSpans: z.boolean().optional().describe('true 时附 source spans（文本模式为紧凑行，json 模式为结构化数组）；默认只返回窗口和文本。'),
      json: z.boolean().optional().describe('true 时返回原始结构化 JSON（window 对象 + 完整 sourceSpans）；默认返回文本（窗口头一行 + 原文 + 可选紧凑 spans 行）。')
    }
  }, async ({ docId, nodeId, startOffset, limit, before, spansLimit, includeSpans, json }: DocIdArg & LimitArg & JsonArg & {
    nodeId?: DocId; startOffset?: number; before?: number; spansLimit?: number; includeSpans?: boolean;
  }) => {
    const argv = ['article', String(docId)];
    if (nodeId !== undefined) argv.push('--node-id', String(nodeId));
    if (startOffset !== undefined) argv.push('--start', String(startOffset));
    if (before !== undefined) argv.push('--before', String(before));
    if (limit !== undefined) argv.push('--limit', String(limit));
    if (spansLimit !== undefined) argv.push('--spans-limit', String(spansLimit));
    if (includeSpans) argv.push('--spans');
    if (json) argv.push('--json');
    return textResult(await dbShell(client, argv));
  });

}

export function registerAgentTools(server: McpServer, client: BackendClient, tier = TIER) {
  // A2A 委托内置 agent 的入口按档位化（projectneed 18-1）：ask_agent 恒 qa（read 档·只读问答），
  // edit_agent（edit 档）/admin_agent（full 档）委托更高能力；委托权限不超过调用方自身档位，
  // 按档位注册不同动词、不在单一动词内按档位切 mode。
  const isWriteTier = tier === 'edit' || tier === 'full' || tier === 'human';
  const isFullTier = tier === 'full' || tier === 'human';
  const registerAgentDelegate = (name: string, mode: string, description: string) => {
    server.registerTool(name, {
      description,
      inputSchema: { prompt: z.string(), docId: docIdSchema.optional(), sessionId: z.number().int().positive().optional() }
    }, async ({ prompt, docId, sessionId }: DocIdOptionalArg & { prompt: string; sessionId?: number }, extra: any) => {
      const payload: Record<string, unknown> = { mode, prompt };
      if (docId) payload.docId = docId;
      if (sessionId) payload.sessionId = sessionId;
      // 委托内置 agent 是长任务（检索+多轮推理），单次回包前默认无声 → 调用方 MCP 客户端会 -32001 超时。
      // 跑期间周期发 progress 通知保活（仅在调用方请求带 progressToken + resetTimeoutOnProgress 时生效）。
      const progressToken = extra?._meta?.progressToken;
      let keepAlive: NodeJS.Timeout | null = null;
      if (progressToken != null && typeof extra?.sendNotification === 'function') {
        let ticks = 0;
        keepAlive = setInterval(() => {
          extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: (ticks += 1), message: `${name} 运行中…` }
          }).catch(() => { /* 通知失败不影响主流程 */ });
        }, 20000);
        if (typeof keepAlive?.unref === 'function') keepAlive.unref();
      }
      try {
        const result = await client.runAgent(payload) as { answer?: string; error?: string; sessionId?: number } | null;
        const answer = result?.answer || result?.error || '(无回答)';
        const sid = result?.sessionId != null ? `\n\n[sessionId: ${result.sessionId}]` : '';
        return textResult(`${answer}${sid}`);
      } finally {
        if (keepAlive) clearInterval(keepAlive);
      }
    });
  };
  registerAgentDelegate('ask_agent', 'qa',
    '直接问本产品的内置文档智能体（A2A，read 档·只读问答，恒 qa 不随档提权）。它会按检索纪律自己查文档、读正文、附证据节点再回答。docId 指定当前文档；sessionId 用于多轮续接（把上轮返回的 sessionId 传回来）。');
  if (isWriteTier) registerAgentDelegate('edit_agent', 'edit',
    'edit/full/human 档可见：委托内置 agent 以 edit 能力代劳；修改写入文档唯一草稿，草稿须先由用户打开。多轮/证据纪律同 ask_agent。');
  if (isFullTier) registerAgentDelegate('admin_agent', 'full',
    'full/human 档可见：委托内置 agent 以 full 能力运维——在 edit 提议之外还可做历史改写、流式、索引补建等运维。多轮/证据纪律同 ask_agent。');
}

// 探活：process.kill(pid, 0) 不发信号、只探进程是否存在。ESRCH=不存在；EPERM=存在但无权限（仍算活）。
function isBackendProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string } | null)?.code === 'EPERM';
  }
}

// 强杀后端并确认退出：优雅 shutdown 兜不住时（host 崩在加载 native 不响应 shutdown、或被别的客户端长
// 操作阻塞在队列）必须真把它杀掉。Windows 的 process.kill 只 TerminateProcess 单进程、不杀子进程也不等
// 退出；这里用 taskkill /T /F 杀整棵进程树，posix 用 SIGKILL，再轮询确认 pid 真消失（最多 ~3s）——不是
// 发个信号就算数。SQLite(WAL)/LanceDB(版本化提交) 崩溃安全，强杀不致损坏。
async function forceKillBackend(pid: number): Promise<boolean> {
  if (!isBackendProcessAlive(pid)) return true;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* 可能正好自己退出了 */ }
  for (let i = 0; i < 30; i += 1) {
    if (!isBackendProcessAlive(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !isBackendProcessAlive(pid);
}

function registerLifecycleTools(server: McpServer, client: BackendClient) {
  server.registerTool('restart_backend', {
    description: 'full 档运维：强制重启共享后端。先优雅关停、再按 pid 强杀整棵进程树并确认退出——确保被其他客户端（opencode/codex 等）续住、或崩在加载 native 不响应 shutdown 的旧后端也被真正杀掉。下次工具调用会拉起 node runtime 的最新实例（host 恒 node ABI，与本 shell 自己跑 node 还是 electron 无关）。会中断其余客户端正在进行的后端操作（它们下次调用自会重连/重拉）。工具 schema 未变，无需重连 MCP。'
  }, async () => {
    // pid 取自当前连接的 ready 帧；本进程还没连过后端时回退描述文件——别的客户端/GUI 续住的游离
    // 后端 pid 一直记在那里，否则首调会因 client.pid 为 null 误判「未启动」而漏杀。
    // transport.sharedBackendPid 在 backend-client 处声明为 unknown（IPC 边界），收口为 number | null。
    const pid: number | null = (client.sharedBackendPid as number | null) ?? null;
    try {
      await client.shutdown();
    } catch { /* 后端可能已在退出 */ }
    client.close();
    let outcome: string;
    if (!pid) {
      outcome = '当前未启动';
    } else if (pid === process.pid) {
      outcome = `pid=${pid}（即本进程，跳过）`;
    } else {
      const dead = await forceKillBackend(pid);
      outcome = `pid=${pid}（${dead ? '已终止' : '强杀后仍未退出，请手动检查'}）`;
    }
    // 清自己认得的陈尸连接描述：避免下次发现复用死 pid/pipe；pid 不匹配（已被新后端重写）则不动。
    try {
      removeBackendDescriptorIfOwn(backendDescriptorPath(resolveBackendDbPath(PROJECT_ROOT)), pid);
    } catch { /* 描述不存在或已被新后端重写 */ }
    return textResult(`已关闭后端（${outcome}）。下一次 MCP 工具调用会拉起最新实例（node runtime）；工具 schema 未变，无需重连 MCP。`);
  });
}

// Progressive tier (projectneed `18-3`): read = read tools only; edit adds
// import/delete plus review of proposed changes; full adds accepting + saving.
export function registerWriteTools(server: McpServer, client: BackendClient, tier: string) {
  const draftDocId = (docId?: DocId) => docId ?? selectedDocId ?? undefined;
  const importLibraryDocument = async ({ relativePath, mode, embed, vectors }: {
    relativePath: string; mode?: string; embed?: boolean; vectors?: boolean;
  }) => {
    // vectors 是 push 的内联向量口径、不是 import 的开关——传错直接回报错，别静默不建。
    if (vectors !== undefined) return textResult('import 不接受 vectors 参数；导入时同步建向量用 embed:true（vectors 是 push 的内联向量口径）。');
    const argv = ['import', String(relativePath)];
    if (mode) argv.push('--mode', String(mode));
    if (embed === true) argv.push('--embed');
    return textResult(await dbShell(client, argv));
  };

  const ensureVectors = async ({ docId }: DocIdArg) => textResult(await dbShell(client, ['vectors', String(docId)]));

  const saveBranch = async (input: DocIdOptionalArg & DraftSummaryArg = {}) => {
    const docId = draftDocId(input.docId);
    if (!docId) return textResult('commit 需要 docId，或先 switch 到默认文档。');
    const argv = ['commit', String(docId)];
    const summary = input.summary || input.tag;
    if (summary) argv.push('--summary', String(summary));
    return textResult(await dbShell(client, argv));
  };

  const stepEditBranchEntry = async (action: string, input: DocIdOptionalArg = {}) => {
    const docId = draftDocId(input.docId);
    if (!docId) return textResult(`${action} 需要 docId，或先 switch 到默认文档。`);
    return textResult(await dbShell(client, [action, String(docId)]));
  };

  server.registerTool('edit', {
    description: `edit/full/human 档可见：把节点备注/类型、引用或实体动作写入文档唯一草稿，不直接改主库。省略 docId 时使用 switch 当前文档。${nodeTypeContractText}`,
    inputSchema: {
      action: z.enum([
        'node.update',
        'ref.addNodeToNode',
        'ref.delete',
        'entity.create',
        'entity.update',
        'entity.delete',
        'entity.link',
        'entity.unlink',
        'entity.bindNode',
        'entity.ignoreNode',
        'entity.clearNodeBinding'
      ]),
      nodeId: docIdSchema.optional().describe('node.update 的目标节点 id。'),
      nodeType: z.string().optional().describe(`node.update 的节点类型。${nodeTypeContractText}`),
      nodeNote: z.string().optional().describe('node.update 的节点备注。'),
      payload: z.record(z.string(), z.any()).optional().describe('ref/entity 动作参数。'),
      docId: docIdSchema.optional().describe('目标文档 id；省略时由动作目标反查，再回退 switch 当前文档。')
    }
  }, async ({ action, nodeId, nodeType, nodeNote, payload = {}, docId }: DocIdOptionalArg & {
    action: string;
    nodeId?: DocId; nodeType?: string; nodeNote?: string;
    payload?: Record<string, unknown>;
  }) => {
    const named = { nodeId, nodeType, nodeNote };
    const writePayload: Record<string, unknown> = { ...payload };
    for (const [key, value] of Object.entries(named)) {
      if (value !== undefined) writePayload[key] = value;
    }
    const argv = ['edit', action, JSON.stringify(writePayload)];
    const targetDocId = draftDocId(docId);
    if (targetDocId !== undefined) argv.push('--doc-id', String(targetDocId));
    return textResult(await dbShell(client, argv));
  });

  server.registerTool('draft', {
    description: '为文档打开唯一草稿。已有活跃草稿时幂等返回原草稿。',
    inputSchema: { docId: docIdSchema }
  }, async ({ docId }: DocIdArg) => textResult(await dbShell(client, ['draft', String(docId)])));

  server.registerTool('commit', {
    description: '定稿：把文档唯一草稿的 active entries 重放到正文、创建历史并销稿。',
    inputSchema: {
      docId: docIdSchema.optional(),
      summary: z.string().optional(),
      tag: z.string().optional().describe('作为 summary 使用。')
    }
  }, saveBranch);

  server.registerTool('switch', {
    description: '设置当前默认文档。后续 edit/diff/commit/discard/undo/redo 省略 docId 时使用它。',
    inputSchema: { docId: docIdSchema }
  }, async ({ docId }: DocIdArg) => {
    selectedDocId = docId;
    return textResult(await dbShell(client, ['switch', String(docId)]));
  });

  server.registerTool('import', {
    description: '导入 library 内真实文件。当前可执行 mode 为 simple / complete / direct / vector；smart 仅为兼容值，通用入口尚未接入。',
    inputSchema: {
      relativePath: z.string().describe('library 内相对路径，不要使用绝对路径。'),
      mode: z.enum(['simple', 'complete', 'direct', 'smart', 'vector']).optional(),
      embed: z.boolean().optional()
    }
  }, importLibraryDocument);

  server.registerTool('delete', {
    description: '删除已导入文档的 doc 数据，不删除 library 真实文件；存在活跃草稿时拒绝。',
    inputSchema: { docId: docIdSchema }
  }, async ({ docId }: DocIdArg) => textResult(await dbShell(client, ['delete', String(docId)])));

  server.registerTool('discard', {
    description: '弃稿。默认仅预览，yes=true 时执行。',
    inputSchema: { docId: docIdSchema.optional(), yes: z.boolean().optional() }
  }, async ({ docId: explicitDocId, yes }: DocIdOptionalArg & { yes?: boolean } = {}) => {
    const docId = draftDocId(explicitDocId);
    if (!docId) return textResult('discard 需要 docId，或先 switch 到默认文档。');
    const argv = ['discard', String(docId)];
    if (yes) argv.push('--yes');
    return textResult(await dbShell(client, argv));
  });

  server.registerTool('undo', {
    description: '撤销草稿内最后一条 active entry。',
    inputSchema: { docId: docIdSchema.optional() }
  }, (input: DocIdOptionalArg = {}) => stepEditBranchEntry('undo', input));

  server.registerTool('redo', {
    description: '恢复草稿内最近一条 undone entry。',
    inputSchema: { docId: docIdSchema.optional() }
  }, (input: DocIdOptionalArg = {}) => stepEditBranchEntry('redo', input));

  // full/human 档追加低频运维动词；草稿编辑仍走同一套单草稿入口。
  if (tier === 'full' || tier === 'human') {
    server.registerTool('web_search', {
      description: 'full/human 档可见：联网检索（projectneed 15-5-3），用法对齐通用 web_search、保留 URL 校验+内网拦截；只读联网。给 query 返回搜索结果。',
      inputSchema: {
        query: z.string().describe('检索词。'),
        limit: z.number().int().positive().optional().describe('返回结果数上限。')
      }
    }, async ({ query, limit }: LimitArg & { query: string }) => {
      const argv = ['web', 'search', String(query)];
      if (limit) argv.push('--limit', String(limit));
      return textResult(await dbShell(client, argv));
    });

    server.registerTool('restore', {
      description: 'full/human 档可见：按 commit id（UUID）、committed_at 精确时间戳或 summary tag 精确回滚文档历史。',
      inputSchema: {
        ref: z.union([docIdSchema, z.string()]).optional().describe('commit id（UUID）、committed_at 或 summary tag。'),
        historyId: docIdSchema.optional().describe('commit id（UUID）；兼容旧入口名。'),
        savedAt: z.string().optional().describe('精确匹配 commits.committed_at。'),
        at: z.string().optional().describe('savedAt 的别名。'),
        tag: z.string().optional().describe('精确匹配 commits.summary。'),
        docId: docIdSchema.optional().describe('ref/tag/savedAt 命中多条时用于限定文档。')
      }
    }, async ({ ref, historyId, savedAt, at, tag, docId }: DocIdOptionalArg & {
      ref?: DocId | string; historyId?: DocId; savedAt?: string; at?: string; tag?: string;
    } = {}) => {
      const argv = ['restore'];
      if (historyId !== undefined) argv.push('--history', String(historyId));
      else if (savedAt || at) argv.push('--at', String(savedAt || at));
      else if (tag) argv.push('--tag', String(tag));
      else if (ref !== undefined) argv.push(String(ref));
      else return textResult('restore 需要 ref/historyId/savedAt/at/tag。');
      if (docId !== undefined) argv.push(String(docId));
      return textResult(await dbShell(client, argv));
    });

    server.registerTool('revert', {
      description: 'full/human 档可见：恢复目标 commit 的父快照，并在当前 HEAD 上创建新 commit；目标之后的 commit 仍保留在历史链中，但其正文效果由父快照覆盖。',
      inputSchema: {
        commitId: z.union([docIdSchema, z.string()]).describe('要撤销的 commit id（UUID）。'),
        docId: docIdSchema.optional().describe('可选，限定文档。'),
        json: z.boolean().optional().describe('true 时返回原始 JSON（含完整 doc 刷新）；默认渲染要点摘要。')
      }
    }, async ({ commitId, docId, json }: DocIdOptionalArg & JsonArg & { commitId: DocId | string }) => {
      const argv = ['revert', String(commitId)];
      if (docId !== undefined) argv.push(String(docId));
      if (json) argv.push('--json');
      return textResult(await dbShell(client, argv));
    });

    server.registerTool('vectors', {
      description: 'full/human 档可见：为已导入文档补建语义向量（重算力，归 full）。只接收 docId。',
      inputSchema: { docId: docIdSchema }
    }, ensureVectors);

    server.registerTool('relink', {
      description: 'full/human 档可见：把已导入 doc 重绑到新的源文件路径（锚改名/迁移后用，15-10-4），更新 meta.sourcePath 与 source_documents.original_path，不动正文、不改 source_type。不强制校验目标存在（记忆/会话卷由对应 agent 自己维护、我们不替外部程序管文件状态），但回执会自检并报 targetExists。',
      inputSchema: {
        docId: docIdSchema,
        sourcePath: z.string().describe('新源文件路径（与 import 记录一致，建议库内绝对路径）。')
      }
    }, async ({ docId, sourcePath }: DocIdArg & { sourcePath: string }) => {
      return textResult(await dbShell(client, ['relink', String(docId), String(sourcePath)]));
    });

    // 'export' 动词已停用（未启用，待重新设计）：原实现把 markdown 渲染结果返回到命令行而非导出为文件，
    // 且渲染有「地址当标题 / 混入 node_note」等功能错误；幂等与 import/export 对称设计尚未确定。
    // 重新设计前不注册此工具，避免 agent 调用到功能错误的导出。旧实现已删除，重做时全新设计。


  }

  if (tier === 'full' || tier === 'human') {
    // full 档运维：对象库 GC（mark-sweep，lazy/手动）——回收不被任何 commit 引用的历史对象。
    server.registerTool('gc_objects', {
      description: 'full 档运维：对象库垃圾回收（mark-sweep）。回收不被任何 commit 引用的历史对象（blob/tree/source）——即删文档/删 commit 后变孤儿的内容寻址对象。reset/revert 跳过的 commit 仍在表中、其对象不会被收（保住可后悔窗口）。不在写热路径，需要时手动跑。'
    }, async () => {
      return textResult(await dbShell(client, ['gc']));
    });
  }

  if (tier === 'human') {
    // human 档专属背书动词：标受控的唯一合法入口。
    server.registerTool('certify', {
      description: 'human 档专属：节点级背书——把节点或整棵子树标受控；作为一次提交进历史，但历史不区分作者。scope=subtree 默认整子树、node 只本节点。',
      inputSchema: {
        docId: docIdSchema,
        nodeId: docIdSchema.optional().describe('目标节点 id；与 address 二选一。'),
        address: z.string().optional().describe('目标节点地址（如 1-3-2）；与 nodeId 二选一。'),
        scope: z.enum(['subtree', 'node']).optional().describe('subtree 默认标整子树 / node 只本节点。'),
        trust: z.enum(['受控', '不受控']).optional().describe('默认受控；不受控用于撤销背书。')
      }
    }, async ({ docId, nodeId, address, scope, trust }: DocIdArg & AddressArg & {
      scope?: 'subtree' | 'node'; trust?: '受控' | '不受控';
    }) => {
      const argv = ['certify', String(docId)];
      if (address !== undefined) argv.push(String(address));
      if (nodeId !== undefined) argv.push('--node-id', String(nodeId));
      if (scope === 'node') argv.push('--node');
      if (trust !== undefined) argv.push('--trust', String(trust));
      return textResult(await dbShell(client, argv));
    });
  }
}

async function main() {
  // 后端共用（projectneed 18-6-1）：写档（edit/full）实例经连接描述文件发现并复用共享后端，
  // 连不上自行拉起（detached），单机离线回退私有 stdio；只读实例照旧各起私有后端（并发读安全）。
  const hostScriptPath = join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js');
  // 统一 backend-client SDK：写档（edit/full）走共享管道复用同一后端、只读档走私有 stdio（并发读安全）；
  // 各动词只调 SDK 的语义方法、内部不再散写 request('database.read'...)。
  const client = createBackendClient({
    projectRoot: PROJECT_ROOT,
    hostScriptPath,
    mode: IS_WRITE_TIER ? 'shared' : 'private',
    onStderr: (text: unknown) => { process.stderr.write(String(text ?? '')); },
    onStatus: (text: unknown) => { process.stderr.write(String(text ?? '')); }
  });

  // schema 自述（projectneed 15-12-5 / 18-8-1）：外部 agent 接入第一读物。
  // 数百 token 的约定说明，不是内容清单——不预载"库里有什么"。
  const SERVER_INSTRUCTIONS = [
    'IF-Tree 条件树知识库。本说明是接入约定，不是内容清单——知道库里有什么是检索的产物，不是检索的前提，请直接检索。树地址统一：1 是根，1-3-2 是 1-3 的第 2 个子节点，前缀即父子。',
    '',
    '检索动词：library_index（库目录）、tree（结构）、read（正文）、find（多词 AND 关键词 / semantic 语义）、article（原文窗口）、log/diff（历史）、sql（只读核对）、ask_agent（问内置智能体）。查询纪律：命中预览只用于选候选，下结论前必须 read 回正文证据；搜索为空先拆词重试、再下钻结构，不要直接断言没有。',
    '',
    '信任语义：节点分受控（经人工审批）/不受控（机器产物未经人审）；导入知识文档默认无人工标注（trust 为空 NULL），实践中按不受控对待。命中未解决的 ERROR 节点必须停下向用户报告，不得绕过续跑。',
    '',
    '时间纪律：召回结果附带时间元数据，采信前先看时间；同主题证据冲突新者胜，不得以"内容看起来更合理"推翻时间新旧；找不到更新的证据时，旧证据就是最佳可用证据，知旧而用。',
    '',
    `当前接入档位（IFTREE_MCP_TIER）=${TIER}：read 只读检索 / edit 草稿编辑 / full 追加运维动词 / human 追加 certify。草稿与提交历史均不区分 owner。`
  ].join('\n');

  const server = new McpServer({ name: 'iftree-library', version: '0.2.0' }, { instructions: SERVER_INSTRUCTIONS });
  registerRetrievalTools(server, client);
  registerAgentTools(server, client, TIER);
  registerLifecycleTools(server, client);
  if (IS_WRITE_TIER) registerWriteTools(server, client, TIER);

  const shutdown = async () => {
    // 共享后端（mode==='pipe'）是多客户端复用的，不能因单个 MCP 退出而全局关停——只断开本连接。
    // 私有兜底后端（private）/只读档自起的 headless（无 mode）由本进程独占，正常 shutdown 免泄漏子进程。
    // restart_backend 仍走 client.shutdown()（有意全局重启共享后端），不受此处影响。
    try {
      if (client.mode !== 'pipe') await client.shutdown();
    } catch { /* already closing */ }
    client.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
}

// 仅在作为入口直接运行时自启 server；被测试 import 时不启动。
if ((process.argv[1] || '').endsWith('mcp-server.js')) main().catch((error) => {
  process.stderr.write(`${(error as { stack?: string } | null | undefined)?.stack || (error as { message?: string } | null | undefined)?.message || error}\n`);
  process.exit(1);
});
