# PRD — nextcloud-mcp-server

## 产品目标

- 要达成的目标：让 AI 助手（大语言模型）能够通过标准化的 MCP 工具调用，安全、高效地访问 Nextcloud 中的文件数据——搜索、浏览、阅读内容、下载文件、查询存储状态——同时遵守 Nextcloud 的用户权限体系。

## 用户与使用场景

- 目标用户：
  - 学校教务管理人员——需要快速查找和阅读分布在 Nextcloud 各文件夹中的规章制度、考勤记录、成绩报表
  - 教师——需要通过自然语言查询自己权限范围内的课程文件
  - AI 应用开发者——需要在 MCP 客户端中集成 Nextcloud 数据源
- 典型场景：
  - "帮我找一下教务处文件夹里所有关于考勤的 xlsx 文件"
  - "读取 /教务处/考勤/2025年1月考勤.xlsx 的内容，告诉我一年级三班的出勤率"
  - "下载 /校务公开/最新通知.pdf 的原文件"
  - "检查用户 zhang_san 对这几个文件有没有读权限"
  - "我的存储空间用了多少？"

## 核心问题

- 要解决的关键问题：
  1. AI 助手无法直接访问内网 Nextcloud 文件系统
  2. Nextcloud 文件分散、路径深层嵌套，手动查找效率低
  3. 需要遵守用户权限——不同用户看到不同的文件子集
  4. 文件格式多样（xlsx、docx、pdf），需要自动解析为可读文本
  5. 大文件直接传输不可行，需要分 chunk 或限制大小

## 功能及其意义

| 功能 | 解决什么 | 为什么需要 |
|------|----------|------------|
| nextcloud_search_files | 按关键词、扩展名、路径搜索文件 | 用户只知道文件大概名字或内容关键词，需要快速定位 |
| nextcloud_list_directory | 浏览某个目录下的文件和子目录 | 用户不知道文件确切名称，需要像文件管理器一样浏览 |
| nextcloud_read_file | 读取文件文本内容（缓存优先） | 找到文件后需要看内容；缓存避免重复下载解析 |
| nextcloud_download_file | 下载文件为 base64 二进制 | 图片等非文本文件无法提取文字，需要原文件 |
| nextcloud_get_storage_stats | 查询用户存储使用量 | 用户想知道自己还有多少空间 |
| nextcloud_check_permissions | 批量检查文件读权限 | 在展示文件列表前验证访问权限 |
| nextcloud_sync_status | 查看索引同步状态 | 了解数据新鲜度——上次同步是什么时候 |

## 功能之间的关系

- 典型工作流：`search_files` → 找到目标文件路径 → `read_file` 或 `download_file`
- 另一个工作流：`list_directory` → 浏览目录结构 → `read_file`
- 权限贯穿：所有文件访问工具都支持可选的 `userId` 参数进行权限过滤
- 数据依赖：所有工具依赖 `files_index` PostgreSQL 表（由外部同步程序维护）和 `document_texts` 表（文本缓存）

## 范围与非目标

- 范围内：
  - 只读访问：搜索、列出、阅读、下载、统计
  - 7 个 MCP 工具，基于 HTTP Streamable Transport
  - PostgreSQL 索引 + WebDAV 实时下载双通道
  - 权限集成（school_ai_permission API）
  - 文本提取：txt、md、csv、docx、xlsx、pdf

- 范围外：
  - 文件写入 / 上传 / 删除 / 移动
  - 用户认证与授权（token 发放、SSO）
  - files_index 同步任务（由外部 cron / scheduler 负责）
  - OCR / 图片内容识别
  - 实时文件监控（watch / webhook）
  - 多 Nextcloud 实例支持（当前只支持单实例）