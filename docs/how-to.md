# 操作指南

> [上手教程](getting-started.md) · **操作指南** · [参考手册](reference.md) · [概念与设计](concepts.md)

任务式的「怎么做 X」。每节独立成立，按需查阅。

## 配置 LLM 供应商

LLM 用在三处：节点 / 全文摘要、内置 agent 对话、智能导入。配置分两层：

1. **API Key**：复制 `.env.example` 为 `.env`，填入 Key。`.env` 在 `.gitignore` 中，不会被提交。
2. **供应商与模型**：设置页维护多供应商、多 API 配置（会写回 `.env` 与 `iftree.config.json`，Key 只进 `.env`）。

支持两种接口协议，按供应商选择：

- **OpenAI 兼容**：请求 `{baseUrl}/chat/completions`。DeepSeek、MiniMax、智谱 GLM、Kimi、Gemini、Grok 的 OpenAI 兼容端点都走这条。
- **Anthropic 兼容**：请求 `{baseUrl}/v1/messages`，用 `x-api-key` 与 `anthropic-version` 头，需在 API 配置中填最大输出 token。

本地模型用 Ollama 的 OpenAI 兼容端点接入即可（`http://localhost:11434/v1`）。

设置页内置千问 Qwen 供应商预设，走 Token Plan 的 Anthropic Messages 兼容端点：

| 模型 | 预设特性 |
| --- | --- |
| Qwen3.8 Max Preview | `maxOutputTokens=65536`；思考强度 `low` / `medium` / `xhigh` |
| Qwen3.7 Plus | `maxOutputTokens=65536` |
| Qwen3.6 Flash | `maxOutputTokens=65536` |

选择预设后只需填写 API Key；base URL、模型名与协议已经写入供应商配置。LLM 供应商与下面的语义向量模型是两套独立设置。

## 构建语义向量

语义检索按含义找句子，前提是先为文档建向量。

默认模型是 Ollama 的 `qwen3-embedding:0.6b`，初始 384 维：

1. 安装并启动 Ollama，执行 `ollama pull qwen3-embedding:0.6b`。
2. 在设置页选择 **Qwen3 Embedding 0.6B**。维度可在 32–1024 之间调整，第一次建议保持 384。
3. 对已导入文档补建向量：应用内触发，或命令行 `npm run vectors:ensure -- <docId>`。

Qwen 的模型文件、量化格式和 CPU / GPU 放置由 Ollama 管理，所以选择 Qwen 时，设置页的计算目标、本地 ONNX 路径与下载按钮会禁用。后端向 Ollama `/api/embed` 发送当前 `dimensions`；文档原文直接作为 passage，只有查询会自动添加 Qwen 的英文检索 instruction。

仍保留三个固定 1024 维选项：BGE-M3、BGE Large ZH v1.5、BGE Large EN v1.5。选择 Transformers.js BGE 模型后，才使用 GPU（WebGPU）/ CPU（wasm）、本地 ONNX 目录与设置页下载按钮。

通用调优项：worker 数默认 4，batch size 默认每批 16 条；可关闭“导入时生成向量”。改变模型或维度会清空旧 LanceDB 表并按新维度重建，已有文档需要重新补建。

**embedding 服务连接**：`.env` 中的 `IFTREE_EMBED_*` 可配置 Ollama（`POST {baseUrl}/api/embed`）或 OpenAI 兼容端点（`POST {baseUrl}/v1/embeddings`）。选择内置 Qwen 模型时始终使用 Ollama 和 `qwen3-embedding:0.6b`，不会被遗留的 BGE 环境变量替换，也不会失败回落到 Transformers.js。

## 导入各格式文档

把源文件放进 `library/`，应用内从文档库面板发起导入。

| 格式 | 结构来源 | 注意 |
| --- | --- | --- |
| `.txt` | 标题行、段落、句子 | 无格式约定的纯文本按段落 / 句子切 |
| `.md` | heading、段落、句子 | 推荐格式，结构最稳 |
| `.docx` | OOXML 段落样式 `<w:pStyle>` | 标题靠样式识别；手动加粗当标题的文档识别不到层级 |
| `.pdf` | 文本层映射 | 需要有文本层；扫描件先 OCR |
| `.chm` | `.hhc` 目录 + HTML 正文 | 按目录层级生成结构树 |
| `.epub` | EPUB 章节与正文 | 保留章节层级，句子可定位回原文 |

Excel `.xlsx` 与 CSV `.csv` 当前不支持普通文档导入；数据库中继格式也尚未实现。

导入粒度在导入期锁定：入库后没有段落切分 / 合并的通道，重在导入前确认源文结构。结构不规则、规则解析不出来的源文，走下一节的智能导入。

## 用智能导入处理无规则结构的源文

智能导入的本质：让一个 LLM 观察源文样本、写一次性切割脚本产出 JSON，经 `db import-json` 逐字节校验后入库。LLM 只贡献结构，不贡献正文——正文必须是源文的逐字节切片，校验器逐字比对，改一个字都过不了。

两种用法：

- **应用内**：导入对话框选「智能导入」。应用会发起一轮 full 模式的内置 Agent 会话；Agent 按 smart-import skill 观察源文、写一次性切割脚本、反复 dry-run，最后用 `db import-json` 原子入库。过程可在 Agent 面板观察，不再经过编辑分支审批。
- **外部 agent**：任何能跑脚本的 agent（Claude Code、Codex 等）按 [`.iftree-llm-workspace/skills/smart-import/SKILL.md`](../.iftree-llm-workspace/skills/smart-import/SKILL.md) 的契约操作：观察样本 → 写切割脚本 → `db import-json <json> <源文> --dry-run` 预检 → 按报告修脚本 → 去掉 `--dry-run` 正式入库。

应用内智能导入是独立的 Agent 工作流。通用 `db import` 与 MCP `import` 当前只可使用 `simple`、`complete`、`direct`、`vector`；虽然兼容 schema 仍接受 `smart`，执行时会明确报告该入口未接入。

当前 JSON 只需表达「章节 → 自然段」结构，并在顶层设置 `"splitSentences": true`。章节标题和自然段都使用 `text`；不用写 `nodeTitle`，地址也可省略，系统会按 `children` 前序生成连续地址，并把自然段细切成句子子节点。

dry-run 报告怎么读：

- `missing`——正文在源文中找不到：九成是脚本动了内部空白 / 换行；
- `out_of_order`——顺序与源文不一致：检查脚本遍历顺序；
- `address_*`——显式地址不连续或父前缀错；通常直接省略地址交给系统生成；
- `uncovered`——源文有带字的区间没被任何节点覆盖：系统不替你补、也不放行，对照 `textPreview` 修切割脚本后重新 dry-run。

JSON 契约的完整字段表见[参考手册](reference.md#import-json-契约)。

## 把库开放给外部 agent

MCP server 以 stdio 方式运行，权限档在启动时由环境变量 `IFTREE_MCP_TIER` 决定：

| 档位 | 取值 | 能做什么 |
| --- | --- | --- |
| 问答 | `read`（默认） | 检索、读正文、查历史、问内置 agent |
| 协作 | `edit` | 问答档全部 + 唯一草稿、导入、删除；草稿只允许节点备注 / 类型、引用与实体动作 |
| 完全 | `full` | 协作档全部 + restore / revert、向量重建、源文件重绑、联网检索与对象库 GC |
| 人类 | `human`（别名 `yolo`） | 完全档全部 + `certify` 节点背书；这是把内容标为受控的唯一入口 |

客户端配置（以 Claude Code 的 `.mcp.json` 为例，放在本项目根目录）：

```json
{
  "mcpServers": {
    "iftree-library": {
      "command": "npm",
      "args": ["run", "--silent", "mcp:node"],
      "env": {
        "IFTREE_MCP_TIER": "read"
      }
    }
  }
}
```

外部 agent 的常用动线：`find`（关键词 / 语义检索挑候选）→ `read`（取回正文证据，带地址）→ 回答引用地址。命中过碎时读父地址或相邻地址补上下文。

注意事项：

- 协作档及以上，每篇文档只有一份活跃草稿；`edit` 只能修改节点备注 / 类型以及引用、实体，不允许改正文或树结构。`commit` 将草稿快进落入正文历史。
- 更新代码或原生模块后，调 `restart_backend` 工具让 MCP 重新拉起后端子进程。
- 应用、MCP、命令行共享同一个后端进程（一库一后端），可以同时开着应用和 agent，互不冲突。

## 数据备份、迁移与多库隔离

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 源文档 | `<项目根>/library/` | 你自己组织的源文件，自行备份 |
| 主数据库 | `<项目根>/database/store.sqlite` | 文档、节点、历史等全部结构化数据 |
| Agent 会话库 | `<项目根>/database/agent.sqlite` | 内置 Agent 会话、消息与上下文；待审修改在主数据库的文档唯一草稿中 |
| 向量 / 附件 | `<项目根>\database\`（默认，与主库同根；`IFTREE_HOME` 可覆盖） | `vectors\nodes.lance`、`assets\doc-<id>\` |

- 备份：`library/` + `database/store.sqlite` 可恢复文档数据；需要保留 Agent 对话时再备份 `database/agent.sqlite`。向量可随时重建。
- 换库 / 隔离测试：`IFTREE_DB` 指定另一个 SQLite 路径，`IFTREE_HOME` 指定另一个派生数据目录（也可把向量库挪到大盘）。

**库级迁移 / 重建**（升级或调整库结构时）：数据库带 schema 版本号、启动只读校验；schema 演进走「导出 → 建新空库 → 导入」的一次性往复，不在旧库原地改。均须先 `npm run build:runtime`、用 node 跑、在共享后端空闲时跑，默认 dry-run、`--apply` 才动：

- `node dist/scripts/export-db-to-json.js [输出路径]` —— live 库导成单个 JSON（带 schema 版本头），只读不改源库。
- `node dist/scripts/import-db-from-json.js <dump.json> [目标库] --apply` —— 按最新 schema 建全新空库再灌入。
