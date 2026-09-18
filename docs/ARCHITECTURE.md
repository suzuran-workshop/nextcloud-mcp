# ARCHITECTURE — nextcloud-mcp-server

## 系统概述

- 整体结构：

```
┌─────────────────┐
│   AI 助手        │
│ (Claude / etc.) │
└────────┬────────┘
         │ MCP Protocol (HTTP Streamable)
         ▼
┌─────────────────────────────────────────────────┐
│              nextcloud-mcp-server                │
│                                                  │
│  ┌──────────┐  ┌──────────────────────────────┐ │
│  │  Hono    │  │        MCP Server             │ │
│  │  HTTP    │  │  ┌──────┐ ┌──────┐ ┌──────┐  │ │
│  │  Router  │  │  │search│ │ list │ │ read │  │ │
│  │  /mcp    │  │  ├──────┤ ├──────┤ ├──────┤  │ │
│  │  /health │  │  │ down │ │storage│ │sync │  │ │
│  │          │  │  ├──────┤ ├──────┤ ├──────┤  │ │
│  │          │  │  │perm  │ │      │ │      │  │ │
│  └──────────┘  │  └──────┘ └──────┘ └──────┘  │
│                └──────────────┬───────────────┘ │
│                               │                  │
│         ┌─────────────────────┼──────────┐       │
│         │                     │          │       │
│         ▼                     ▼          ▼       │
│  ┌────────────┐  ┌─────────────────┐ ┌────────┐ │
│  │ PostgreSQL │  │    WebDAV       │ │Perm API│ │
│  │files_index │  │  (Nextcloud)    │ │(custom)│ │
│  │doc_texts   │  │  download+parse │ │        │ │
│  └────────────┘  └─────────────────┘ └────────┘ │
└─────────────────────────────────────────────────┘
```

## 核心模块

| 模块 | 职责 |
|------|------|
| `src/index.ts` | 服务启动、MCP Server 创建与工具注册、Hono 路由（/mcp、/health） |
| `src/config.ts` | 环境变量解析、配置对象导出、必填校验 |
| `src/db.ts` | PostgreSQL 连接池（pg）、参数化查询辅助 |
| `src/tools/search.ts` | 文件搜索——ILIKE 全文匹配 + 权限过滤 |
| `src/tools/list.ts` | 目录列出——直接子项 / 递归两种模式 |
| `src/tools/read.ts` | 文件阅读——缓存优先（document_texts）+ WebDAV 实时回退 |
| `src/tools/download.ts` | 文件下载——WebDAV GET → base64 返回 |
| `src/tools/storage.ts` | 存储统计——优先调用 permission API，回退到 index 汇总 |
| `src/tools/sync.ts` | 同步状态——查询 sync_runs 表最近记录 |
| `src/tools/permission.ts` | 批量权限——封装 permission API 调用并格式化输出 |
| `src/nextcloud/webdav.ts` | WebDAV 协议——PROPFIND 列出、GET 下载、递归遍历 |
| `src/nextcloud/permission.ts` | 权限集成——school_ai_permission API 调用、候选行过滤 (authorizeCandidateRows) |
| `src/nextcloud/utils.ts` | 工具函数——Basic Auth、路径解析、URL 构建、字节格式化 |
| `src/extractors/text.ts` | 文本提取——mammoth (docx)、pdf-parse、xlsx、纯文本 |

## 模块关系

- `index.ts` → 注册所有 `tools/*` 为 MCP 工具，通过 `CallToolRequestSchema` 分发请求
- `tools/*` → 依赖 `db.ts`（SQL 查询）、`nextcloud/webdav.ts`（文件下载）、`nextcloud/permission.ts`（权限校验）、`extractors/text.ts`（文本提取）
- `nextcloud/*` → 依赖 `config.ts`（连接参数）、`nextcloud/utils.ts`（辅助函数）
- 工具层不直接访问 `process.env`——全部通过 `config.ts`

## 数据流

1. **搜索 / 列出**：MCP request → tool handler → PostgreSQL files_index 查询 → 可选权限过滤 (authorizeCandidateRows) → JSON 响应
2. **阅读文件**：MCP request → files_index 查找 → document_texts 缓存命中 → 直接返回；缓存未命中 → WebDAV 下载 → extractTextFromBuffer → 返回文本
3. **下载文件**：MCP request → files_index 查找 → 权限校验 → WebDAV GET → base64 编码 → 返回
4. **权限检查**：MCP request → school_ai_permission API POST → 解析结果 → 返回
5. **存储统计**：MCP request → person storage API → 成功则返回用户配额；失败则回退到 files_index 聚合统计

## 外部系统

| 系统 | 用途 | 协议 |
|------|------|------|
| PostgreSQL | 文件索引 (files_index)、文本缓存 (document_texts)、同步记录 (sync_runs) | TCP / pg 协议 |
| Nextcloud WebDAV | 实时文件下载与目录列出 | HTTPS / WebDAV |
| school_ai_permission API | 用户权限校验与存储统计 | HTTPS / REST |

## 重要技术边界

- MCP 传输：WebStandardStreamableHTTPServerTransport——每次请求生成新 sessionId，无状态
- 文件大小限制：文本提取 ≤20MB（MAX_EXTRACT_FILE_MB），下载 ≤50MB（MAX_DOWNLOAD_MB），通过 config 可配置
- 权限过滤：search 查询时多取 5 倍数据（limit × 5），权限过滤后再截断至 limit，提高命中率
- 文本缓存策略：document_texts 表存储已提取文本，extract_status = "success" 时直接返回，避免重复下载解析
- 数据库连接池：最大 5 连接，30 秒空闲超时