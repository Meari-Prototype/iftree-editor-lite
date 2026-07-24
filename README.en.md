# IF-Tree Editor Lite

[简体中文](README.md) · **English**

> A local-first document data management tool: it organizes multi-document corpora into address-stable if-trees so you can pinpoint the exact passage you need within large bodies of text (designed for up to tens of billions of characters). Search results trace back to their precise source, and the corpus can be handed to external agent frameworks for collaborative processing via MCP.
>
> **IFTreeEditorLite is the lite edition of IFTreeEditor: a strictly single-machine, personal knowledge base.** For enterprise-grade, multi-endpoint, complex deployments, see its sister project IFTreeEditor. This project is built on IFTreeEditor **0.6.6**, takes an optimistic approach to most scenarios, and sharply pares back the feature surface. The frontend currently has no known bugs or crashes in read-only mode; **for a first try, start with the paper-reading experience in the PDF view**.

![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)
![platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![status](https://img.shields.io/badge/status-0.2.0%20alpha-orange)

> **Project status: 0.2.0, early development.** The project is under active development; treat it as an early release:
>
> - **Frontend**: no known bugs or crashes in read-only mode (including PDF paper reading); editing and collaboration features are still being refined.
> - **Backend write path**: lacks long-term real-world testing — the project is young, so there simply hasn't been enough accumulated runtime yet.
> - **Ready to use**: the core **MCP read-only query service** and **db command contract** are stable and usable; read-only retrieval is the most dependable part right now.
>
> See the [CHANGELOG](CHANGELOG.md) for version history.

---

## Table of Contents

- [Introduction](#introduction)
- [Documentation](#documentation)
- [Features](#features)
- [Screenshots](#screenshots)
- [Tech Stack](#tech-stack)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Data Storage](#data-storage)
- [Semantic Vectors](#semantic-vectors)
- [Import & Export](#import--export)
- [MCP & External Agents](#mcp--external-agents)
- [Project Structure](#project-structure)
- [Development & Testing](#development--testing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Introduction

IF-Tree Editor is a local-first document data management tool aimed at large multi-document corpora (designed for up to tens of billions of characters). The problem it solves: accurately finding the passage you need within a large body of text, and making sure the result is verifiable and not replaced by a model's guesswork. To that end, it organizes source text into an address-stable condition tree:

- Each node has an address like `1`, `1-3`, `1-3-2`: `1` is the root, `1-3` is the third child of `1`, and the address prefix expresses the parent–child relationship. Addresses are generated from `parent_id + sort_order`, giving every sentence a stable, citable coordinate.
- Keyword search and local semantic search, combined with sentence-level offset mapping, narrow a hit down to specific sentences rather than a whole document. By default, Ollama runs `qwen3-embedding:0.6b` and returns 384-dimensional vectors.
- Data is stored locally (SQLite + LanceDB), with no cloud dependency. When answering factual questions, the built-in agent must first read textual evidence and cite the evidence node address rather than relying on the model's general knowledge — keeping answers verifiable.
- Via MCP, the document library is exposed to external agent frameworks under tiered permissions (Q&A / collaborate / full) for retrieval and collaborative processing.

The same content can switch between two reading densities: collapsed, it reads like a Markdown document; expanded, it becomes an operable condition tree. On import, the sentence-to-source offset mapping is preserved so both views correspond to the same original text.

## Documentation

In-depth documentation lives in `docs/` (currently in Chinese):

- [Getting started](docs/getting-started.md) — install to first search in 15 minutes.
- [How-to guides](docs/how-to.md) — LLM setup, vectors, imports, smart import, connecting external agents, backup.
- [Reference](docs/reference.md) — MCP tools, db commands, the import-json contract, config and environment variables.
- [Concepts & design](docs/concepts.md) — addresses, trust levels, the single-draft model, and the shared backend.
- [Changelog](CHANGELOG.md)

## Screenshots

Reading papers in the PDF view is the headline experience: import, read, then let the Agent look at the page and explain it.

| Document import | PDF paper reading |
|-----------------|-------------------|
| ![Document import](docs/images/pdf-import.png) | ![PDF paper reading](docs/images/pdf-reading.png) |
| Import a pending document manually, with simple / complete / smart / direct / vector modes. | Read papers in the PDF view, with highlight annotation and sentence-level locating. |

| Agent Q&A on a section | Agent reading a figure |
|------------------------|------------------------|
| ![Agent Q&A on a section](docs/images/agent-qa.png) | ![Agent reading a figure](docs/images/agent-screenshot.png) |
| Ask about the selected section; the Agent reads the source and cites evidence nodes. | The Agent captures the current window with `db screenshot` and explains figures in the paper. |

| Settings · General | Settings · Agent |
|--------------------|------------------|
| ![Settings · General](docs/images/settings-general.png) | ![Settings · Agent](docs/images/settings-agent.png) |
| Permissions, storage locations, reading preferences and UI language, all stored locally. | Provider and API configuration with OpenAI / Anthropic compatible endpoints. |

## Features

- **Precise retrieval**: keyword search + local semantic search with sentence-level offset mapping, locating a hit to specific sentences; the default is Qwen3 Embedding 0.6B through Ollama at 384 dimensions, with automatic query instructions and Chinese, English, and Japanese retrieval.
- **Evidence-based answers**: when answering factual questions, the built-in agent reads textual evidence and gives the evidence node address, rather than answering from the model's general knowledge or the wording of the question; results are verifiable.
- **Local-first storage**: documents, nodes, ERRORs, references, and history live in SQLite; node-level semantic vectors live in LanceDB — usable with no cloud service.
- **Agent collaboration & MCP**: the built-in agent and the MCP server share one permission tiering (Q&A / collaborate / full / human); external agent frameworks can search and read evidence, while the collaborate tier can only change node notes/types, references, and entities in the document's single draft. The LLM layer supports both OpenAI-compatible and Anthropic-compatible APIs.
- **Address-stable condition tree**: node addresses look like `1-3-2` and are generated from `parent_id + sort_order`, so every sentence can be cited precisely.
- **Dual-density reading**: collapsed it renders as a Markdown document, expanded as an operable condition tree; the tree view expands to the document's true maximum depth by default, with expand/collapse by level and expand-all / collapse-all.
- **Lightweight workbench**: a three-column document/content/LLM layout; the content area only switches between tree and rich-text views, search lives in the document sidebar, and entity maintenance opens in a separate window.
- **Restricted node editing**: edit mode only changes node type and notes; body text and tree structure are immutable; draft entries support undo / redo.
- **Single-draft fast-forward commits**: each document has at most one active draft, finalized only through `commit`; merge, rebase, cherry-pick, and conflict resolution are absent.
- **Shared backend**: one backend process per database — the app, MCP, and CLI share it over a named pipe and can stay online at the same time without conflict.
- **Multi-format import & full-database backup**: import CHM, TXT, Markdown, PDF, DOCX, and EPUB; irregular sources can use the in-app smart import flow (an LLM produces JSON that is validated byte-for-byte before ingestion); ordinary Excel / CSV import and database relay formats are not implemented yet; maintenance scripts export and import full-database JSON backups (Markdown document export is being redesigned and is temporarily disabled).
- **AI summary notes**: call an OpenAI- or Anthropic-compatible API to generate summary notes for a single node, a subtree, the current level, or the whole document.
- **Node metadata**: node type, notes, ERRORs, references, and save history.

## Tech Stack

| Area | Choice |
| --- | --- |
| Desktop framework | Electron 39 |
| UI | React 19 + Vite 7 |
| Local database | better-sqlite3 |
| Vector database | LanceDB |
| Semantic vectors | Ollama (default `qwen3-embedding:0.6b`); Transformers.js BGE options remain available |
| Agent / tool protocol | @modelcontextprotocol/sdk (MCP) |
| Others | pdfjs-dist, fflate, lucide-react, @radix-ui |

## Requirements

- **OS**: Windows 10 / 11; Linux and macOS can use the POSIX shell launcher (development and verification are currently performed mainly on Windows).
- **Node.js**: 20 LTS or newer recommended (verified on Node 24). Native modules (better-sqlite3) are prebuilt for the **node ABI** (downloaded via `prebuild-install`, no build toolchain needed); tests, CLI, MCP, and the backend all run on plain node (see [Development & Testing](#development--testing) for the ABI note).
- **Package manager**: npm.
- **Semantic vector models (optional)**: the project does not require Qwen3 or BGE to start. Without either model, only semantic-vector indexing and retrieval are unavailable; keyword search and all other features continue to work. The default Qwen option requires local Ollama with `qwen3-embedding:0.6b`; BGE requires the optional local Transformers.js inference dependency.
- **GPU (optional)**: Ollama chooses CPU or GPU automatically; Transformers.js BGE models can be switched between WebGPU and CPU in settings.

## Quick Start

Install dependencies (first time):

```powershell
npm install
```

Build the frontend and launch the app:

```powershell
npm run build
npm run app
```

> `npm run app` first builds, then prebuilds better-sqlite3 for the node ABI. The desktop shell is Electron, but the frontend no longer uses native modules in-process — the main process spawns a separate node backend. After changing the main process or preload, restart the Electron window.

Development mode uses two terminals. Start the Vite dev server in terminal 1:

```powershell
npm run dev
```

In terminal 2, point Electron at that server:

```powershell
$env:IFTREE_WEB_URL = 'http://127.0.0.1:5173'
npm run app
```

On Windows you can also double-click `start.bat`. On Linux or macOS, run this from the project root:

```sh
sh start.sh
```

Both scripts run “install dependencies → build → launch” automatically.

## Configuration

### LLM API (`.env`)

Copy `.env.example` to `.env` and fill in your key. LLM summaries and the built-in agent support two API protocols, selectable per provider on the settings page:

- **OpenAI-compatible**: requests `{baseUrl}/chat/completions`.
- **Anthropic-compatible**: requests `{baseUrl}/v1/messages`, using the `x-api-key` and `anthropic-version` headers; a max output token value must be set in the API configuration.

Ollama local models and services such as DeepSeek can both be reached through these protocols (DeepSeek's Anthropic-compatible endpoint defaults to `https://api.deepseek.com/anthropic`).

The settings page includes presets for OpenAI, Claude, MiniMax, Zhipu GLM, Kimi, Qwen, Gemini, Grok / xAI, and NVIDIA Developer. The Qwen preset uses the Token Plan Anthropic Messages-compatible endpoint and includes Qwen3.8 Max Preview, Qwen3.7 Plus, and Qwen3.6 Flash; you still enter the API key in settings.

The common environment variables for the OpenAI-compatible path:

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-pro
```

The multi-provider configuration maintained on the settings page is written back to `.env`; see the comments in that file. `.env` is in `.gitignore` and is not committed.

### Application config (`iftree.config.json`)

Controls summary strategies, agent tool parameters, and debug logging, including summary word-count bounds, compression ratio, and search-result limits. Debug logs are written to `.iftree-debug/`. Field details: [reference](docs/reference.md#配置与环境变量).

### Data directory (`IFTREE_HOME`)

Set the `IFTREE_HOME` environment variable to override the default data directory, which is handy for testing or isolating different datasets.

## Data Storage

The app involves four kinds of local data: the **document library** you manage, the **main database** parsed from it, the separate **Agent conversation database**, and rebuildable **derived data** (vectors and attachments).

### Document library (`library/`)

`library/` lives at the project root and is the workspace that stores and organizes all source documents (`.chm` / `.txt` / `.md` / `.pdf` / `.docx` / `.epub`), which can be arranged into folders. It is this tool's most important data: the app browses and organizes the library as a folder tree, and the built-in agent can only read/write inside `library/` using relative paths, never exposing absolute paths.

`library/` is in `.gitignore` — it is your data and is not distributed with the repository. It is entirely separate from `docs/`: the former is the managed document corpus, the latter is just project documentation; do not merge `library/` into `docs/`.

### Main database and Agent conversation database

The structured data parsed on import — documents, nodes, ERRORs, references, entities, and commit history — lives in `database/store.sqlite` at the project root (gitignored). Use the `IFTREE_DB` environment variable to point at a different path.

Built-in Agent sessions, messages, and context are stored separately in `database/agent.sqlite`; pending changes reuse the document's single draft in the main database. Back up the Agent database as well if conversation history matters.

### Derived data (defaults to `database\`, overridable with `IFTREE_HOME`)

Vectors and attachments default to the main database's directory `database\` (anchored to the workspace to avoid a split from SQLite; still overridable with `IFTREE_HOME`):

```text
database\               # same directory as store.sqlite (IFTREE_HOME default)
  vectors\nodes.lance\  # node-level semantic vectors
  assets\doc-<id>\      # document attachments (images, etc.)
```

The original Markdown reading source is stored in SQLite's `source_documents` / `source_spans`; sentence splitting only stores the offset mapping and does not restructure the body text. A tree node can aggregate and display sentence-number ranges such as `23-25;27-28;32`.

## Semantic Vectors

- The default model is Ollama's `qwen3-embedding:0.6b` at 384 dimensions. Settings can adjust it within the model's supported 32–1024 range, and the database validates the selected dimension exactly.
- Document text is embedded unchanged as passages. Search text receives Qwen's official English retrieval instruction in the backend before it is embedded as a query; the instruction is never written back to node content.
- Ollama manages Qwen model files and CPU/GPU placement, so the Transformers.js compute-target, local-path, and download controls are disabled for this model. Run `ollama pull qwen3-embedding:0.6b` before first use.
- BGE-M3, BGE Large ZH v1.5, and BGE Large EN v1.5 remain available as fixed 1024-dimensional options. The Transformers.js BGE path supports WebGPU / CPU, local ONNX directories, and manual download, with 4 workers and batches of 16 texts by default.
- Changing the model or dimension drops the old LanceDB table and recreates its schema, preventing vectors from different models or dimensions from being mixed. Automatic embedding during import can also be disabled in settings.

## Import & Export

**Import**

| Format | Notes |
| --- | --- |
| CHM `.chm` | Builds the structure tree from the `.hhc` table of contents and HTML body |
| Text `.txt` | Builds the hierarchy from heading lines, paragraphs, and sentences |
| Markdown `.md` | Builds the hierarchy from headings, paragraphs, and sentences |
| PDF `.pdf` | PDF import with text-layer mapping |
| DOCX `.docx` | Detects heading levels from the OOXML paragraph style `<w:pStyle>` |
| EPUB `.epub` | Parses chapter structure and body text; sentences trace back to the source |

Excel `.xlsx` and CSV `.csv` are not currently supported for ordinary document import; database relay formats are not implemented yet either.

Sources too irregular for rule-based parsing can use the in-app **smart import** flow: an LLM inspects the source, writes a one-off splitting script that produces JSON, and `db import-json` validates it byte-for-byte before ingestion — body text may only be sliced from the source, never rewritten. The generic `smart` mode of `db import` / MCP `import` is not wired up; external agents should follow the `smart-import` contract and call `db import-json` directly (see the [how-to guide](docs/how-to.md#用智能导入处理无规则结构的源文)).

**Export**: maintenance scripts can export the full database to JSON with a schema-version header and import it into a new empty database. Markdown document export is being redesigned and is temporarily disabled in this release.

## MCP & External Agents

The MCP server exposes the library to external agent frameworks such as Claude Code and Codex over stdio. The permission tier is locked at launch by the `IFTREE_MCP_TIER` environment variable: `read` (search and read, default), `edit` (+ the single draft, import, and delete), `full` (+ restore/revert, vector rebuild, source relinking, web search, and object-store GC), and `human` (alias `yolo`; adds node certification and is the only entry point that can mark content as trusted).

Client configuration example (with the project root as working directory):

```json
{
  "mcpServers": {
    "iftree-library": {
      "command": "npm",
      "args": ["run", "--silent", "mcp:node"],
      "env": { "IFTREE_MCP_TIER": "read" }
    }
  }
}
```

The app, MCP, and CLI share one backend process per database and can stay online together. The tool list and the `db` command contract are in the [reference](docs/reference.md); the smart-import contract for external agents ships with the repository under [`.iftree-llm-workspace/skills/`](.iftree-llm-workspace/skills/).

## Project Structure

```text
.
├── electron/
│   ├── web-shell.ts      # Thin Electron shell: starts the local Web service, loads WebUI, and manages main/entity windows
│   ├── ipc-channels.ts   # IPC channel constants
│   └── preload.ts        # Exposes only OS capabilities such as windows and file pickers
├── index.html            # Renderer entry HTML
├── src/
│   ├── renderer/
│   │   └── main.tsx      # React mount entry
│   ├── frontend/         # UI layer
│   │   ├── App.tsx       # Assembly root: hook / command wiring and context composition
│   │   ├── screens/      # Screen-level splits: editor / settings / left sidebar / workspace / dialog host
│   │   ├── commands/     # Command layer: editor / document / agent / treeView business verbs
│   │   ├── stores/       # Lightweight stores and the edit-lifecycle state machine
│   │   ├── session/      # Document session: windowed loading & eviction, undo stack and snapshot tokens
│   │   ├── components/   # Tree, rich text, search, Agent, entity-window, and settings components
│   │   ├── hooks/        # React hooks: document state, layout, selection, settings, etc.
│   │   ├── data/         # HTTP RPC / repository / service wrappers
│   │   ├── features/     # Feature actions: entities, library, settings, etc.
│   │   ├── lib/          # Frontend utilities
│   │   └── styles.css
│   ├── backend/web/      # Local HTTP RPC, SSE, static WebUI, and settings I/O
│   ├── backend/          # Backend business logic (runs in a separate node backend process)
│   │   ├── store/        # Storage core / history / edit-branch subsystems (SQLite schema, document/node writes)
│   │   ├── db/           # schema, ids, normalizers, snapshot history, content-addressed object store
│   │   ├── entities/     # Entity read/write and projection
│   │   ├── editor-session/ # Editor session and snapshot tokens
│   │   ├── diff/         # ref / view diff computation
│   │   ├── derived-index/ # Derived indexes (keyword / semantic-status) and reconciliation
│   │   ├── projection/   # Edit-branch projection cache
│   │   ├── source/       # Source document address mapping
│   │   ├── text/         # Text budgeting / merging
│   │   ├── import/       # Import orchestration and JSON persistence
│   │   ├── library/      # Library filesystem and virtual documents
│   │   ├── handlers/     # Read / write command handlers
│   │   └── llm/          # Agent runtime, shared backend SDK (named pipe), headless agent, LLM settings
│   ├── mcp/              # MCP server entry (`src/mcp/mcp-server.ts`, built to `dist/src/mcp/mcp-server.js`)
│   ├── core/             # Pure logic (no Electron dependency)
│   │   ├── tree.ts       # Tree building, dynamic addresses, flatten / traversal
│   │   ├── mindmap.ts    # Tree-view projection, depth control, layout
│   │   ├── merkle.ts / merkle-diff.ts # Tree hashing and history diff
│   │   ├── source-text.ts / source-pdf.ts / source-docx.ts / source-chm.ts / source-epub.ts # Works with import-formats/ to parse txt/md/pdf/docx/chm/epub
│   │   ├── source-markdown.ts # Source parsing and sentence offset mapping
│   │   └── ...           # viewport, markdown, tree-cursor, tree-ui, flat-tree, etc.
│   ├── vector/           # Semantic vectors: embeddings, vector-store, worker, model download
│   └── agent/            # Agent config and session storage
├── scripts/              # CLI tools: db commands, native rebuild, verification scripts, import/export/migration
├── tests/                # node:test unit tests
├── docs/                 # Project documentation: tutorial / how-to / reference / concepts
├── .iftree-llm-workspace/
│   └── skills/           # Import contracts for LLMs (shipped with the repo)
├── library/              # Document library workspace: your source documents (created at runtime, gitignored)
├── database/             # store.sqlite, agent.sqlite, and derived data (created at runtime, gitignored)
├── iftree.config.json    # Summary strategy / agent tool / render mode config
└── .env.example          # Environment variable template (LLM API)
```

## Development & Testing

```powershell
npm run lint          # ESLint static checks (src / electron / scripts / tests)
npm run check:types   # TypeScript type check (core typed; other modules still migrating)
npm run build         # production build (esbuild compiles runtime .ts into dist/)
npm run check:native  # verify native modules match the node ABI
npm test              # run unit tests with node --test
npm run test:verbs    # run the db verb-contract suite with node --test
```

> The `verify:samples` command depends on local sample data; prepare the corresponding files before running it. Verification involving the database, import, LanceDB, or native modules runs on plain node (e.g. `npm run check:native`).

> **Native module ABI**: native modules (better-sqlite3, LanceDB) are binaries compiled for a specific runtime ABI. This project uses the **node ABI** — better-sqlite3 pulls a node prebuilt via `prebuild-install` (no build toolchain), and `@lancedb/lancedb` is an N-API prebuilt usable from both node and Electron. Tests, CLI, MCP, and the backend all run on system `node` (`npm test` / `node dist/scripts/<script>.js` / `npm run mcp:node`). The desktop `npm run app` is still an Electron shell, but the frontend no longer uses native modules in-process — the main process spawns a separate node backend, and Electron itself rebuilds nothing. `npm run check:native` verifies better-sqlite3 against the node ABI.

## License

Released under the [Apache License 2.0](LICENSE), copyright Meari (see [NOTICE](NOTICE)).

## Acknowledgments

- The UI bundles the [Noto Sans CJK](src/frontend/assets/fonts/NOTICE.md) font (SIL Open Font License).
- Semantic vectors default to [Qwen3 Embedding 0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B), with [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) and other BGE models retained.
- Built with open-source projects including Electron, React, Vite, Ollama, LanceDB, and Transformers.js.
- Developed with the help of ChatGPT 5.6 sol, ChatGPT 5.5, Claude Opus 4.8, Claude Opus 4.7, Claude Sonnet 5, Claude Fable 5, GLM 5.2, DeepSeek V4, and Kimi K3.
