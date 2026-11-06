import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { randomUUID } from "crypto";
import { config } from "./config.js";
import { query } from "./db.js";
import { searchFiles } from "./tools/search.js";
import { listDirectory } from "./tools/list.js";
import { readFile } from "./tools/read.js";
import { downloadFileTool } from "./tools/download.js";
import { getSyncStatus } from "./tools/sync.js";
import { runSync, syncState } from "./sync.js";
import { askQuestion, searchContent, getStats } from "./nextcloud/ai.js";

const TOOLS: Tool[] = [
  {
    name: "nextcloud_search_files",
    description:
      "Search files in Nextcloud by file name, path, or folder keyword. " +
      "Supports Chinese, extension filter, and folder prefix. " +
      "Uses the local files_index (refresh with nextcloud_sync).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword or filename. Supports Chinese and partial matches." },
        limit: { type: "number", default: 20, maximum: 200 },
        extension: { type: "string", description: "Filter by extension, e.g. xlsx, pdf, docx." },
        folderPath: { type: "string", description: "Folder path prefix, e.g. /演示文件夹." },
      },
      required: ["query"],
    },
  },
  {
    name: "nextcloud_list_directory",
    description: "List files and subdirectories under a Nextcloud path (from files_index).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "/", description: "Directory path, default /." },
        recursive: { type: "boolean", default: false },
        limit: { type: "number", default: 100, maximum: 500 },
      },
      required: [],
    },
  },
  {
    name: "nextcloud_read_file",
    description:
      "Read the extracted text of a file (txt/md/csv/docx/xlsx/pdf/pptx). " +
      "Cached text first, live WebDAV download + extraction on cache miss.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Full path from nextcloud_search_files / nextcloud_list_directory." },
        maxChars: { type: "number", default: 50000 },
      },
      required: ["filePath"],
    },
  },
  {
    name: "nextcloud_download_file",
    description: "Download a file as base64 binary (for images, binaries, or non-text formats).",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "nextcloud_ask",
    description:
      "Ask a natural-language question over all indexed Nextcloud documents. " +
      "Routes through the AI assistant's intent engine (file search / semantic / stats / LLM answer) " +
      "and returns the answer with source files. This is the primary '问数' tool.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question about Nextcloud documents, in Chinese or English." },
      },
      required: ["question"],
    },
  },
  {
    name: "nextcloud_search_content",
    description:
      "Search inside document text/chunks. keyword = literal matching, " +
      "semantic = pgvector similarity, hybrid = both merged.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 10, maximum: 50 },
        mode: { type: "string", enum: ["keyword", "semantic", "hybrid"], default: "hybrid" },
      },
      required: ["query"],
    },
  },
  {
    name: "nextcloud_stats",
    description: "Get index statistics: summary / by-folder / by-extension / recent.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["summary", "by-folder", "by-extension", "recent"], default: "summary" },
        limit: { type: "number", default: 30 },
      },
      required: [],
    },
  },
  {
    name: "nextcloud_sync",
    description:
      "Full sync of the Nextcloud service-account scope into files_index: " +
      "PROPFIND walk, metadata upsert, text extraction, chunking and pgvector rebuild. " +
      "Runs automatically on startup and every AUTO_SYNC_INTERVAL_MINUTES; call manually to refresh now.",
    inputSchema: {
      type: "object",
      properties: {
        extractText: { type: "boolean", default: true },
        rebuildVectors: { type: "boolean", default: true },
      },
      required: [],
    },
  },
  {
    name: "nextcloud_sync_status",
    description: "Get recent sync runs plus the in-process sync state.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 5 },
      },
      required: [],
    },
  },
];

function createMcpServer(): Server {
  const server = new Server(
    { name: "nextcloud-mcp-server", version: "2.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (args || {}) as any;

    try {
      switch (name) {
        case "nextcloud_search_files": return callResult(await searchFiles(a));
        case "nextcloud_list_directory": return callResult(await listDirectory(a));
        case "nextcloud_read_file": return callResult(await readFile(a));
        case "nextcloud_download_file": return callResult(await downloadFileTool(a));
        case "nextcloud_ask": return callResult(await askQuestion(a.question));
        case "nextcloud_search_content":
          return callResult(await searchContent(a.query, Number(a.limit || 10), a.mode || "hybrid"));
        case "nextcloud_stats": return callResult(await getStats(a.scope || "summary", Number(a.limit || 30)));
        case "nextcloud_sync":
          return callResult(await runSync({
            extractText: a.extractText !== false,
            rebuildVectors: a.rebuildVectors !== false,
          }));
        case "nextcloud_sync_status": {
          const status = await getSyncStatus({ limit: a.limit });
          return callResult({ ...status, running: syncState.running, startedAt: syncState.startedAt, finishedAt: syncState.finishedAt });
        }
        default:
          return callResult({ ok: false, message: `Unknown tool: ${name}` }, true);
      }
    } catch (error) {
      return callResult(
        { ok: false, message: `Tool execution failed: ${(error as Error).message}` },
        true,
      );
    }
  });

  return server;
}

function callResult(result: Record<string, unknown>, isError = false) {
  return {
    isError: isError || result.ok === false,
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

async function main() {
  const app = new Hono();
  const mcpServer = createMcpServer();

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer.connect(transport);

  app.all("/mcp", async (c) => transport.handleRequest(c.req.raw));

  app.get("/health", async (c) => {
    let database = "ok";
    let indexedFiles: number | null = null;
    try {
      const result = await query("SELECT COUNT(*)::int AS c FROM files_index WHERE is_deleted = FALSE");
      indexedFiles = Number((result.rows[0] as { c: number }).c);
    } catch (error) {
      database = `failed: ${(error as Error).message}`;
    }
    return c.json({
      ok: database === "ok",
      service: "nextcloud-mcp-server",
      version: "2.0.0",
      nextcloud: config.nextcloudBaseUrl,
      ai: config.aiBaseUrl,
      database,
      indexedFiles,
      syncRunning: syncState.running,
      syncLastResult: syncState.lastResult,
      tools: TOOLS.length,
    });
  });

  console.error(`Nextcloud MCP server listening on http://${config.host}:${config.port}`);
  console.error(`MCP endpoint: http://${config.host}:${config.port}/mcp`);
  console.error(`Health: http://${config.host}:${config.port}/health`);
  console.error(`Tools: ${TOOLS.map((t) => t.name).join(", ")}`);

  serve({ fetch: app.fetch, hostname: config.host, port: config.port });

  if (config.autoSyncOnStart) {
    setTimeout(() => {
      runSync().then((result) => {
        console.error("startup sync:", JSON.stringify(result));
      }).catch((error) => console.error("startup sync failed:", error));
    }, 5000).unref();

    if (config.autoSyncIntervalMinutes > 0) {
      setInterval(() => {
        if (!syncState.running) {
          runSync().then((r) => console.error("scheduled sync:", JSON.stringify(r)))
            .catch((error) => console.error("scheduled sync failed:", error));
        }
      }, config.autoSyncIntervalMinutes * 60_000).unref();
    }
  }
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
