# nextcloud-mcp-server

通过 MCP（Model Context Protocol）协议为 AI 助手提供 Nextcloud 文件数据访问能力——搜索、浏览、阅读、下载。

## 这是什么？

- 定位：MCP 服务器，作为 AI 助手（如 Claude）与 Nextcloud 文件系统之间的桥梁。
- 解决的核心问题：AI 助手无法直接访问 Nextcloud 中的文件数据；本服务通过 PostgreSQL 索引 + WebDAV 实时下载 + 权限过滤三层机制，将 Nextcloud 文件暴露为 MCP 工具调用。

## 为什么存在？

- 背景 / 动机：学校教务场景中大量文件（考勤表、成绩单、规章制度）存储在 Nextcloud 上，教师和管理员需要通过 AI 助手自然语言查询和阅读这些文件。原有方案需要人工下载、转换、粘贴，效率极低。
- 通过 MCP 标准化接口，AI 助手可以直接搜索、列出、阅读、下载 Nextcloud 中的文件，并自动处理权限校验和文件格式解析。

## 如何安装和运行？

- 前置要求：Node.js >= 20、pnpm、PostgreSQL（需预先建立 files_index 索引表）
- 安装步骤：
  ```bash
  pnpm install
  cp .env.example .env   # 编辑 .env 填入实际配置
  pnpm build
  ```
- 运行 / 启动：
  ```bash
  pnpm start             # 生产模式
  pnpm dev               # 开发模式（tsx 热重载）
  ```
  MCP 端点：`http://localhost:3101/mcp`
  健康检查：`http://localhost:3101/health`

## 当前状态

- 阶段：开发中
- 已知限制：
  - files_index 需要外部同步程序填充（本服务只读不写）
  - 权限过滤依赖 `school_ai_permission` 自定义 Nextcloud 应用
  - 不支持文件上传 / 写入操作

## 核心技术

- 语言 / 框架 / 关键依赖：
  - TypeScript (ES2022, ESM)
  - Hono — HTTP 服务器框架
  - @modelcontextprotocol/sdk — MCP 协议实现
  - PostgreSQL (pg) — 文件索引查询
  - WebDAV (fast-xml-parser) — 实时文件下载
  - mammoth / pdf-parse / xlsx — 文档文本提取