# 上手教程

> **上手教程** · [操作指南](how-to.md) · [参考手册](reference.md) · [概念与设计](concepts.md)

这篇带你从零走通一遍核心流程：装好应用、导入第一个文档、看懂两种阅读密度、完成第一次检索，最后（可选）让一个外部 agent 连上你的库。预计 15 分钟。

## 前置条件

- Windows 10 / 11，或带 POSIX shell 的 Linux / macOS（当前开发与验证主要在 Windows 上进行）。
- Node.js 20 LTS 或更高，npm。
- 可选：本机 Ollama（使用默认 Qwen 语义向量时需要）；GPU 由 Ollama 自动使用，没有 GPU 也可运行。

## 第一步：安装与启动

```powershell
npm install
npm run build
npm run app
```

Windows 上一键启动：直接双击仓库根目录的 `iftree.exe`（几十 KB 的 NSIS 启动器，随仓库分发）。它会探测依赖——没有 `node_modules` 才显示安装卡片静默跑 `npm install` 和构建，已有依赖则直接拉起应用，全程不弹命令行窗口。`start.bat` 是等价的手动脚本备选。

一般无需重新编译启动器；若要改图标或启动逻辑，编辑 `iftree-launcher.nsi`（图标改其中的 `MUI_ICON`）后用 `npm run makensis` 重编。注意该脚本写死了 NSIS 默认安装路径 `C:\Program Files (x86)\NSIS\makensis.exe`，本机 NSIS 装在别处时需先改成实际路径。

Linux / macOS 在项目根目录运行：

```sh
sh start.sh
```

这些方式都会自动完成「安装依赖 → 构建 → 启动」。首次启动前会按 node ABI 预编译原生模块（better-sqlite3，`prebuild-install`），需要等一会。

Electron 会启动本地 Web 服务并直接打开主界面，不经过启动器。也可以运行 `npm run dev:web`，在普通浏览器里调试同一套 WebUI。

## 第二步：导入第一个文档

把一个 `.md` 或 `.txt` 文件放进项目根目录的 `library/` 文件夹——它是文档库工作区，应用内按文件夹树浏览。然后在左侧文档库面板找到这个文件，走导入对话框，选**简单导入**。

导入完成后进入树视图。每个节点有一个形如 `1`、`1-3`、`1-3-2` 的**地址**：`1` 是根，`1-3` 是它的第 3 个子节点。地址由导入后的父子关系动态生成，让每个句子都有可引用坐标；检索结果、Agent 回答和节点引用都用地址说话。

## 第三步：两种阅读密度

同一份内容可以在两种密度之间切换：折叠时是一篇普通的 Markdown 文档，展开时是可逐层操作的条件树。导入时保留了句子到原文的 offset 映射，所以两种视图对应的是同一份原文，不是两份拷贝。

中间正文区只在树视图和富文本视图之间切换。

## 第四步：第一次检索

在左栏搜索框选择“关键词”模式并输入检索词。命中列表给出节点地址与预览，点击后跳到对应位置。切换成“向量”模式时只执行语义召回，不同时运行关键词检索。

语义检索（按含义找而不是按字面找）需要先为文档构建向量。默认模型是 Ollama 的 `qwen3-embedding:0.6b`，默认 384 维；首次使用先启动 Ollama 并执行：

```powershell
ollama pull qwen3-embedding:0.6b
```

随后在设置页保持 Qwen 模型，按需调整维度并补建向量。BGE-M3 等固定 1024 维模型仍可选，但走 Transformers.js 时才需要选择 GPU / CPU 与下载 ONNX 模型。完整步骤见[操作指南：构建语义向量](how-to.md#构建语义向量)，第一次上手可以跳过。

## 第五步（可选）：让外部 agent 连上库

主窗口右栏保留可收起的 Agent 对话面板。

如果你用 Claude Code、Codex 这类外部 agent 框架，可以通过 MCP 把库开放给它。在你的 agent 框架的 MCP 配置里加一项（以项目根为工作目录）：

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

`IFTREE_MCP_TIER=read` 是只读档：agent 能检索、读正文、查历史，不能写。让它试一句「用 find 检索 ××，然后 read 出命中节点的正文」——回答会带着节点地址，可以核对。四个权限档与全部工具见[参考手册](reference.md#mcp-server)。

## 下一步

- 各种具体任务（配置 LLM、构建向量、导入各格式、智能导入、备份）→ [操作指南](how-to.md)
- 命令与字段的权威清单 → [参考手册](reference.md)
- 为什么这样设计（地址、信任分级、唯一草稿、共享后端）→ [概念与设计](concepts.md)
