# 参考手册

> [上手教程](getting-started.md) · [操作指南](how-to.md) · **参考手册** · [概念与设计](concepts.md)

命令、工具、字段的查表式清单。工具与命令自带的 description / help 是最权威的版本，本文是它们的索引。

## MCP server

- 推荐启动：`npm run mcp:node`（构建后运行 `node dist/src/mcp/mcp-server.js`），stdio 传输。`npm run mcp` 保留 Electron 启动外壳，但后端同样固定运行在真实 Node 进程。
- 权限档由启动时的环境变量 `IFTREE_MCP_TIER` 决定，运行中不可切换：

| 取值 | 档位 | 可见工具 |
| --- | --- | --- |
| `read`（默认） | 问答 | 只读工具 |
| `edit` | 协作 | 只读 + 唯一草稿、导入、删除 |
| `full` | 完全 | 协作 + restore / revert、向量重建、源文件重绑、联网检索、对象库 GC |
| `human`（别名 `yolo`） | 人类 | 完全档全部 + `certify` 节点背书；这是把内容标为受控的唯一入口 |

后端为共享进程：同一数据库的应用、MCP、CLI 汇到同一个 headless 后端，先到者拉起，后来者按数据库路径派生的命名管道接入。

### 只读工具（所有档位）

| 工具 | 作用 |
| --- | --- |
| `library_index` | 按 library 文件夹层级列出已导入文档（ASCII 树，可附 docId、摘要） |
| `tree` | 查看文档结构：缩进 ASCII 树（地址、类型、标题、子树字数），可限子树与层深 |
| `read` | 读取某地址正文，默认整棵子树；`scope=node` 只本节点 / `scope=siblings` 同父前中后三条（首末缺位标〈无〉）；`at` 读历史快照（默认按节点身份穿透） |
| `inspect` | 读某地址的元信息 / 出处 / 引用 / 批注（`sections` 选 meta·source·links·note）；正文用 `read` |
| `find` | 统一检索：默认多词 AND 字面检索（`matchMode=doc` 文档级 / `node` 节点级 / `or` 任一词）；`semantic=true` 语义检索附 score；`entity=true` 实体同义 / 相关列表；`minScore` 高级过滤（语义按相似度下限默认 0.51、字面按命中次数下限）。跨库检索默认排除 `.` 开头隐藏路径，`includeHidden=true` 纳回 |
| `article` | 读取导入文档的原文窗口（按 docId 从头读，或按 nodeId 读附近） |
| `log` | 列出文档保存 / commit 历史 |
| `diff` | 对比唯一草稿↔正文 / 两版历史 / 任意两 ref（`from`/`to`：head·`<commitId>`·draft[:docId]，refA↔refB）。`detail` 切 summary / full（默认），`json` 切结构化输出 |
| `sql` | 只读 SQL 调试查询（仅 SELECT / WITH，readonly 连接校验） |
| `ask_agent` | 问内置文档智能体（A2A）：自己检索、读证据、附地址回答；`sessionId` 多轮续接 |
| `restart_backend` | 重启 MCP 持有的后端子进程（更新代码 / 原生模块后用） |

### 写入工具（`edit` / `full` / `human` 档）

| 工具 | 作用 |
| --- | --- |
| `edit` | 写一条动作进文档唯一草稿，不直接改主库；只支持节点备注 / 类型、引用与实体动作，不支持正文或树结构修改 |
| `draft` | 为文档幂等打开唯一草稿；已有草稿时返回原草稿 |
| `switch` | 切换当前草稿选择（后续草稿动词的默认目标） |
| `undo` / `redo` | 草稿内撤销 / 重做 |
| `commit` | 定稿：把唯一草稿的 active entries 重放到正文、创建历史并销稿 |
| `discard` | 弃稿：默认预览，`yes=true` 执行 |
| `import` | 导入 library 内真实文件，当前可执行 mode 为 simple / complete / direct / vector；`embed=true` 导入后同步建向量、缺省后补。兼容 schema 仍接受 smart，但通用入口尚未接入；智能导入走应用内 Agent 或 `db import-json` |
| `delete` | 删除已导入文档的 doc 数据（不删 library 真实文件；与 `import` 成对，`18-3-1`） |
| `edit_agent` | 委托内置 Agent 以 edit 能力处理任务；修改只进入文档唯一草稿 |

### 管理工具（`full` / `human` 档）

| 工具 | 作用 |
| --- | --- |
| `restore` | 按 commit id、committed_at 时间戳或 summary tag 精确回滚文档历史 |
| `vectors` | 为已导入文档补建语义向量（重算力，归 full） |
| `revert` | 恢复目标 commit 的父快照，并在当前 HEAD 上创建新 commit；目标及其后历史仍保留 |
| `relink` | 把已导入文档重绑到新的源文件路径，只改绑定，不改正文 |
| `web_search` | 联网检索（只读）：对齐通用 web_search，带 URL 校验与内网拦截，给 query 返回搜索结果 |
| `gc_objects` | 对象库垃圾回收（mark-sweep）：回收不被任何 commit 引用的历史对象（blob/tree/source）；reset/revert 跳过的 commit 仍保其对象（可后悔窗口）。不在写热路径、手动跑 |
| `admin_agent` | 委托内置 Agent 以 full 能力执行维护任务 |

Markdown `export`、`merge`、`rebase`、`cherry-pick` 当前均未注册为 MCP 工具。

### 人类工具（仅 `human` 档）

| 工具 | 作用 |
| --- | --- |
| `certify` | 节点级背书：把节点 / 子树标受控——受控内容的唯一合法来源；`scope=node/subtree`、`trust=不受控` 可撤销背书，定位使用 `nodeId` 或 `address` |

## db 命令契约

`db` 是给 LLM 用的统一命令面：内置 agent 的 bash 会话直接可用（由产品注入 LLM 工作区），MCP 工具底层走同一实现。动词分组：

- **检索与读取**：`find`、`keyword`、`index`、`tree`、`read`、`inspect`、`article`、`log`、`diff`、`sql`、`screenshot`（`query` 是 `db find --semantic` 的兼容别名）
- **写入**：`edit`、`import-json`、`import`、`delete`、`vectors`、`relink`
- **草稿**：`draft`、`commit`、`switch`、`undo`、`redo`、`discard`
- **管理**：`restore`、`revert`、`gc`、`certify`
- **本机工具**：`shell`、`web search`、`web open`

`db help` 输出当前版本的权威用法。MCP 工具与 `db` 命令共享底层动作，但工具名和参数 schema 不要求逐字相同。

## 只读查询 CLI

`scripts/query-db.ts` 直接查 SQLite，适合脚本化检查（先 `npm run build:runtime`，再用 node 跑）：

```powershell
node dist/scripts/query-db.js docs
node dist/scripts/query-db.js index --docId $docId --depth 3
node dist/scripts/query-db.js node-content --docId $docId --address 1-4-6 --include tags,source
node dist/scripts/query-db.js search-all --query "keyword" --format ascii_tree
node dist/scripts/query-db.js debug.sql --sql "SELECT COUNT(*) FROM nodes"
```

常用别名：`docs`、`library-index`、`library-navigation`、`index`、`depth`、`node-content`、`subtree`、`search`、`search-all`、`article`、`overview`、`sql`。`help` 列出全部 action。`--db <path>` 或环境变量 `IFTREE_DB` 指定库文件。

## 运维脚本

用 node 跑：先 `npm run build:runtime`，再 `node dist/scripts/<脚本>.js`、在共享后端空闲时跑；迁移类默认 dry-run、`--apply` 才动，详见各脚本头部注释。

| 脚本 | 作用 |
| --- | --- |
| `export-db-to-json.ts` | 库级导出：live 库 → 单个 JSON（带 schema 版本头），只读 |
| `import-db-from-json.ts` | 库级导入：JSON → 按最新 schema 新建的空库 |

## import-json 契约

`db import-json <tree.json> <源文件> [--dry-run] [--embed]`

JSON 结构：

```json
{
  "title": "文档标题",
  "splitSentences": true,
  "nodes": [
    {
      "text": "第一章",
      "nodeNote": "（可选）备注",
      "nodeType": "（可选）缺省 TEXT",
      "children": [
        {
          "text": "源文中的完整自然段。"
        }
      ]
    }
  ]
}
```

| 字段 | 规则 |
| --- | --- |
| `splitSentences` | 智能导入建议设为 `true`：输入只切章节与自然段，系统再把自然段切成句子子节点 |
| `address` | 可省略，系统按 `children` 前序生成连续地址；若显式填写，顶层从 `1-1` 起且每层不能跳号 |
| `text` | 源文的逐字节连续切片，允许去首尾空白，不得改动内部任何字符（含空格、标点、换行） |
| `nodeNote` / `nodeType` | 可选；正文标题也直接放在 `text`，没有 `nodeTitle` 字段 |
| `trustLevel` | 输入值不提升信任；智能导入落库一律为“不受控” |
| `sourcePosition` | 带正文节点可省略，校验器按源文锚点回填；不用空文本虚拟容器时无需手工计算 |

校验规则与报告字段：

- **顺序铁律**：树的前序遍历顺序必须与正文在源文中的出现顺序一致。
- `errors`：`missing`（正文在源文中不存在）、`out_of_order`（位置在已消费区间之前）、`uncovered`（源文有正文未被任何节点覆盖，附 `textPreview`——系统不补不放行，必须改脚本后重试）、`address_*`（显式地址不连续 / 前缀错）、`virtual_source_position`（空文本虚拟容器缺句位）。
- 全部通过返回 `ok: true`；`--dry-run` 只出报告不入库。

## 配置与环境变量

### `iftree.config.json`（项目根）

| 字段 | 作用 |
| --- | --- |
| `llm.summary.*` | 摘要独立配置、字数上下限、压缩比例、文章级 / 节点级策略选择 |
| `llm.shared.providers` | 设置页维护的共享多供应商 / 多 API 列表（Key 不在此文件，只进 `.env`） |
| `llm.agent.*` | 内置 agent 的工具参数与个性化提示 |
| `debugLogging` | 运行日志写入 `.iftree-debug/` |

### `.env`（项目根，不入库）

| 变量 | 作用 |
| --- | --- |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | OpenAI 兼容接口的默认凭据 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 显式 DeepSeek 命名，与 OPENAI_* 同在时优先 |
| `OLLAMA_BASE_URL` | Ollama 本地服务地址 |
| `IFTREE_AGENT_BASE_URL` / `IFTREE_AGENT_MODEL` / `IFTREE_AGENT_API_KEY` | 内置问答 agent 直连模型（覆盖摘要默认，缺省复用 `OPENAI_*`）；`IFTREE_AGENT_TIMEOUT_MS` 单轮超时默认 45s |
| `IFTREE_EMBED_BACKEND` / `IFTREE_EMBED_*` | 远程嵌入连接：`ollama` / `openai`（`_BASE_URL` / `_MODEL` / `_API_KEY` / `_BATCH` / `_WORKERS` / `_FALLBACK`）。模型与维度以设置页为准；内置 Qwen 强制走 Ollama，并把当前维度传给 `/api/embed` |
| `IFTREE_LLM_*` | 设置页自动维护的多供应商配置与各 API 的 Key，一般不手编 |

### 运行时环境变量

| 变量 | 作用 |
| --- | --- |
| `IFTREE_DB` | 主数据库路径，缺省 `<项目根>/database/store.sqlite` |
| `IFTREE_HOME` | 派生数据目录（向量 / 附件），缺省 `<项目根>\database`（与主库 `IFTREE_DB` 同根；不再回落 `%USERPROFILE%\.iftree`，避免向量库与 SQLite 分家） |
| `IFTREE_MCP_TIER` | MCP 权限档：`read` / `edit` / `full` / `human`（别名 `yolo`） |
| `IFTREE_DEBUG_LOGGING` | `1` 强制开 debug 日志（等价于配置文件 `debugLogging: true`） |
| `IFTREE_WEB_URL` | Electron 开发模式加载的 Vite dev server 地址 |
| `IFTREE_WEB_PORT` | 本地 Web 服务监听端口；缺省 `4317` |
| `ELECTRON_RUN_AS_NODE` | Electron 启动外壳内部使用；普通用户无需设置，纯 Node CLI 与 `mcp:node` 不需要 |
