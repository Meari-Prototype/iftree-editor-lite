# 更新日志

记录 IFTreeEditorLite 各公开版本的主要变更。IFTreeEditorLite 与 IFTreeEditor 分别维护版本与发布历史。

## 0.2.1 — 2026-08-02

### 启动与分发

- 新增 Windows 一键启动器 `iftree.exe`（56KB NSIS 自包含，随仓库分发，带项目图标）。探测 `node_modules`：缺依赖才弹安装卡片静默跑 `npm install` 与构建，已有依赖直接拉起应用，全程不弹命令行窗口。`npm run makensis` 可重新编译。
- 空文档态卡片加入「主文件夹」下划线链接，桌面端点击在文件管理器打开 library（不存在自动创建），悬停显示真实路径。

### 外观与主题

- 外观设置改为可增删的配色主题管理：一个主题即一组四色映射（强调色 / 背景 / 次背景 / 前景），内置松绿（新默认）/ 黑曜只读，可新建、重命名、删除自定义主题；配色主题栏为可编辑下拉（就地改名 + 列表选择）。
- 应用主题时除四色外派生 accent-hover、accent-soft/border、文字 accent、边框 / 悬停及 rgb 变体，修掉自定义主题下这些 token 卡在内置值的问题；切回内置主题先清内联覆盖。
- 实体维护按钮在无文档时虚化；「正在打开文档」卡片边框改跟主题边框色。

### 设置与配置

- 设置页 API Key 可单独删除（输入框内垃圾桶按钮，只清 Key 保留其余配置），修复删除后被全局 Key 回填的问题。
- 修复独立后端进程（mcp-server / db CLI）吃不到项目根 `.env`：统一 `.env → process.env` 灌入，嵌入后端与 agent 超时等变量对独立进程生效。
- DeepSeek 推理等级映射对齐 0731 官方文档（补 low 档、显式直通 low/high、xhigh→max），启用 deepseek 供应商。

### 其它

- 「更多」菜单新增「关闭当前文档」（走编辑离场确认，回到空态并清除持久化的 activeDocId）。
- 二级菜单补齐鼠标悬停指示与禁用项浅灰样式。
- `loadComplete` 各段与后台预取加 debug 性能探针，便于定位大文档加载瓶颈。
- 文档：README 快速开始移至目录下方；`docs/getting-started.md` 启动方式更新为 `iftree.exe`。

## 0.2.0 — 2026-07-24

### Agent 与模型

- 重整内置 Agent 的 WebUI 工作流、消息历史和模型上下文管理，补齐设置持久化与回复语气配置。
- 新增图片消息；用户可向 Agent 发送图片，并在消息中查看缩略图与灯箱预览。
- 新增 `db screenshot`，可截取 Electron 当前窗口并通过图片消息链路反馈给视觉模型。
- Anthropic 兼容请求支持 SSE 流式显示；图片请求被模型拒绝时会降级为文本并把失败原因交还 Agent。
- 新增可配置的 Qwen 嵌入模型与 NVIDIA Developer provider。
- 收紧 Agent 权限边界，顶层权限档位贯穿嵌套调用，避免内部工具自行升档。

### 界面与本地化

- 设置界面重组为通用、外观、树视图、Agent、个性化和摘要等独立区域。
- 增加显示缩放、PDF 缩放、文档视图和 C2D 交互相关设置。
- 新增内置 `zh-CN` 与 `en-US` UI 语言包，并集中管理界面文案。
- 完善语义主题 token，界面颜色统一由主题层提供。
- Agent 图片结果、会话菜单、发送按钮及文档阅读界面完成配套调整。

### 稳定性与平台

- 修复数据完整性与本地 Web 安全边界问题。
- 修复 C2D 节点正文渲染时误删子节点内容的问题。
- 保留路径大小写，避免不同平台上的路径解析偏差。
- 新增 Unix 启动脚本 `start.sh`，并同步中英文启动说明。
- 删除未使用的 `@electron/rebuild`，更新可安全修复的传递依赖；Qwen3 与 BGE 模型均保持可选，LanceDB 继续作为必选向量存储。
- 本地 Web 写接口增加 Origin 校验，RPC 仅接受 JSON，阻止网页跨站调用本机控制面。

### 发布前审查修复

- Agent：`db screenshot` 图片回执改作工具结果注入（与文本回执合进同一 tool 消息），视觉兜底改为降级一次重试、失败即提示「你可能没有视觉能力」并保留上下文用文本继续、不整轮失败；修复视觉兜底误触发、工具参数拼接、重试状态机与嵌套 `ask_agent` 取消链路问题；Anthropic 流式 tool_use 兼容 start 帧完整 input。
- Agent 安全：内置 Agent 的 bash 子进程不再继承 LLM API key；纯文字 API 连续失败 5 次回退提示检查网络 / 切换模型。
- 数据一致性：派生索引维护 fire-and-forget 也走单写队列、语义状态写库收进事务；草稿写操作包事务消除崩溃窗口；投影态 entity.create 命中已有实体时登记 tmp 别名，草稿预览不再丢绑定；BM25 增量 hint 不再被提前删除。
- 安全边界：本地 Web 写接口 Origin 校验加端口匹配（含 Vite dev 端口）；`resolveImageSources` 与 `importLocalFiles` 不再可读任意本机文件（后者仅 Electron 壳可用）；窗口截图口校验 Host 为本机回环；导入上传加磁盘空间预检（留 4GB 余量）；SSE 连接死信容错、RPC 请求体加兜底上限。
- 健壮性：配置文件原子写防崩溃留半截；React ErrorBoundary 兜底渲染错误不再白屏；导入畸形数值字符引用与 UTF-16 BE 文本不再中断或乱码；启动失败明确报错退出；`database-command tree --address --depth` 不再静默失效；PDF 视图共享出图密度实例消除资源放大。

## 0.1.1 — 2026-07-18

### Lite 收敛

- 删除旧 UI 验证框架、停用脚本、旧库迁移路径和已经退役的兼容垫片。
- 数据模型删除无行为的 `docs.edit_mode`、引用端类型和三方合并遗留字段。
- `edit_branches` 收敛为单草稿结构，节点类型缩为 `TEXT`、`IF`、`THEN`、`ELSE`、`ERROR` 五种。
- 删除 Merkle 三方合并模块及剩余合并辅助代码。

### 界面与修复

- 改为 Obsidian 风格工作区：左侧 ribbon、可切换侧栏、紧凑顶栏和底部状态栏。
- 新增 pine / obsidian 语义主题、本地 Noto Sans CJK 字体、欢迎卡片与搜索空状态。
- 修复文档行菜单读取失效事件对象导致的白屏。
- 修复新版 Node.js 在 Windows 启动 `npm.cmd` 时的 `EINVAL`。

## 0.1.0 — 2026-07-12

IFTreeEditorLite 的首个独立基线。

- 从 IFTreeEditor 分叉并将项目版本重置为 `0.1.0`。
- 移除事件记忆、核心记忆、记忆投递与提炼等记忆子系统。
- 移除流式写入、增量编辑文档及 `bulk` 批量会话。
- 编辑分支收敛为每篇文档单草稿，删除三方合并、裁决和多草稿相关入口。
- 收窄节点编辑能力并简化为 Lite WebUI。
