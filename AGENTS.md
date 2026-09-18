# AGENTS.md

Nextcloud MCP Server——通过 MCP 协议向 AI 助手暴露 Nextcloud 文件数据的中间层服务。

## 概述

- 本项目是什么：一个 TypeScript MCP 服务器，桥接 AI 助手与 Nextcloud 文件系统。AI 助手通过标准 MCP 工具调用搜索、列出、阅读、下载 Nextcloud 中的文件。

## 边界与范围

- 范围内：
  - 提供 7 个 MCP 工具：搜索文件、列出目录、读取文件内容、下载文件、查询存储统计、批量权限检查、同步状态
  - 从 PostgreSQL `files_index` 表读取文件索引（本服务不负责同步）
  - 通过 WebDAV 实时下载和解析文件（txt/md/csv/docx/xlsx/pdf）
  - 调用 `school_ai_permission` 自定义 API 进行用户级权限过滤
- 非目标（明确排除）：
  - 文件上传 / 写入 / 删除
  - files_index 的同步 / 抓取（由外部调度程序负责）
  - 用户认证（由调用方传递 userId 进行权限判断）
  - 图片 OCR 或富媒体内容提取

## Agent 操作指南

- 如何理解本项目：
  - 入口：`src/index.ts` — Hono HTTP 服务器 + MCP Server 注册
  - 配置：`src/config.ts` — 所有环境变量集中管理
  - 数据库：`src/db.ts` — PostgreSQL 连接池
  - 工具层：`src/tools/*.ts` — 每个 MCP 工具的业务逻辑
  - Nextcloud 集成：`src/nextcloud/webdav.ts`（文件操作）、`src/nextcloud/permission.ts`（权限 API）
  - 文件解析：`src/extractors/text.ts` — 多格式文本提取
- 全局规则 / 约定：
  - TypeScript 严格模式，ESM 模块
  - 所有 MCP 工具返回 `{ ok: boolean, ... }` 统一结构
  - 环境变量通过 `.env` 注入，`requiredEnv()` 在启动时校验
  - 数据库查询使用参数化 SQL，禁止拼接

## 目录速查

- `src/index.ts` — 服务入口，MCP 工具注册与 HTTP 路由
- `src/config.ts` — 环境变量解析与配置对象
- `src/db.ts` — PostgreSQL 连接池与查询辅助
- `src/types.d.ts` — 第三方库类型声明
- `src/tools/search.ts` — `nextcloud_search_files` 工具
- `src/tools/list.ts` — `nextcloud_list_directory` 工具
- `src/tools/read.ts` — `nextcloud_read_file` 工具（缓存优先 + WebDAV 回退）
- `src/tools/download.ts` — `nextcloud_download_file` 工具（base64 返回）
- `src/tools/storage.ts` — `nextcloud_get_storage_stats` 工具
- `src/tools/sync.ts` — `nextcloud_sync_status` 工具
- `src/tools/permission.ts` — `nextcloud_check_permissions` 工具
- `src/nextcloud/webdav.ts` — WebDAV PROPFIND / GET 操作
- `src/nextcloud/permission.ts` — school_ai_permission API 调用与候选行过滤
- `src/nextcloud/utils.ts` — 路径解析、格式化、URL 构建等工具函数
- `src/extractors/text.ts` — 多格式文件文本提取（docx/xlsx/pdf/txt/csv/md）
- `dist/` — TypeScript 编译输出
- `.env.example` — 环境变量模板