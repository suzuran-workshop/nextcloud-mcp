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
import { searchFiles } from "./tools/search.js";
import { listDirectory } from "./tools/list.js";
import { readFile } from "./tools/read.js";
import { downloadFileTool } from "./tools/download.js";
import { getStorageStats } from "./tools/storage.js";
import { getSyncStatus } from "./tools/sync.js";
import { checkPermissionTool } from "./tools/permission.js";

const PORT = Number(process.env.PORT || 3101);
const HOST = process.env.HOST || "0.0.0.0";

const TOOLS: Tool[] = [
  {
    name: "nextcloud_search_files",
    description:
      "Search files in Nextcloud by name, path, or keyword. " +
      "Searches the pre-indexed files_index table using ILIKE matching. " +
      "Supports Chinese and English search terms. " +
      "Results can be permission-filtered by providing a userId.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keyword or filename. Supports Chinese characters and partial matches.",
        },
        userId: {
          type: "string",
          description: "Nextcloud user ID for permission filtering. If provided, only files this user can read are returned.",
        },
        limit: {
          type: "number",
          default: 20,
          maximum: 200,
          description: "Maximum number of results to return.",
        },
        extension: {
          type: "string",
          description: "Filter by file extension (e.g., 'xlsx', 'pdf', 'docx').",
        },
        folderPath: {
          type: "string",
          description: "Filter by folder path prefix (e.g., '/教务处' to only search within that folder).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "nextcloud_list_directory",
    description:
      "List files and subdirectories in a Nextcloud directory path. " +
      "Reads from the files_index table. Supports recursive listing. " +
      "Results can be permission-filtered.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          default: "/",
          description: "Directory path in Nextcloud (e.g., '/教务处/考勤'). Default: root '/'.",
        },
        userId: {
          type: "string",
          description: "Nextcloud user ID for permission filtering.",
        },
        recursive: {
          type: "boolean",
          default: false,
          description: "If true, list all files recursively under this path.",
        },
        limit: {
          type: "number",
          default: 100,
          maximum: 500,
          description: "Maximum number of results to return.",
        },
      },
      required: [],
    },
  },
  {
    name: "nextcloud_read_file",
    description:
      "Read the text content of a file from Nextcloud. " +
      "Supports txt, md, csv, docx, xlsx, pdf files. " +
      "Returns extracted text (not raw bytes). " +
      "Tries cached text first, falls back to live WebDAV download + extraction. " +
      "Permission-checked when userId is provided.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description:
            "The full file path in Nextcloud (e.g., '/教务处/考勤/2025年1月考勤.xlsx'). " +
            "Use nextcloud_search_files or nextcloud_list_directory to find paths.",
        },
        userId: {
          type: "string",
          description: "Nextcloud user ID for permission check.",
        },
        maxChars: {
          type: "number",
          default: 50000,
          description: "Maximum characters to return. Default: 50000.",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "nextcloud_download_file",
    description:
      "Download a file from Nextcloud as base64-encoded binary. " +
      "Use for images, binary files, or any file where you need the raw content. " +
      "Returns base64-encoded data with file metadata.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The full file path in Nextcloud.",
        },
        userId: {
          type: "string",
          description: "Nextcloud user ID for permission check.",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "nextcloud_get_storage_stats",
    description:
      "Get storage usage statistics for a Nextcloud user or the overall index. " +
      "Calls the school_ai_permission storage API for per-user stats. " +
      "Falls back to index-level summary if the API is unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "Nextcloud user ID of the requester (for permission check).",
        },
        targetUserId: {
          type: "string",
          description:
            "Target user to query stats for. If omitted, queries requester's own storage. " +
            "Only admins can query other users' storage.",
        },
      },
      required: ["userId"],
    },
  },
  {
    name: "nextcloud_check_permissions",
    description:
      "Batch-check which files a user has read permission for. " +
      "Calls the school_ai_permission app API. " +
      "Useful for verifying access before showing file lists to users.",
    inputSchema: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "Nextcloud user ID.",
        },
        fileIds: {
          type: "array",
          items: { type: "string" },
          maxItems: 200,
          description: "Array of Nextcloud numeric file IDs. Maximum 200 per request.",
        },
      },
      required: ["userId", "fileIds"],
    },
  },
  {
    name: "nextcloud_sync_status",
    description:
      "Get the status of the last Nextcloud file sync operation. " +
      "Reports when the files_index was last updated from the live Nextcloud server. " +
      "Useful for understanding data freshness.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          default: 5,
          description: "Number of recent sync runs to return.",
        },
      },
      required: [],
    },
  },
];

function createMcpServer(): Server {
  const server = new Server(
    {
      name: "nextcloud-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: { tools: {} },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = args as any;

    try {
      switch (name) {
        case "nextcloud_search_files":
          return callResult(await searchFiles(a));
        case "nextcloud_list_directory":
          return callResult(await listDirectory(a));
        case "nextcloud_read_file":
          return callResult(await readFile(a));
        case "nextcloud_download_file":
          return callResult(await downloadFileTool(a));
        case "nextcloud_get_storage_stats":
          return callResult(await getStorageStats(a));
        case "nextcloud_check_permissions":
          return callResult(await checkPermissionTool(a));
        case "nextcloud_sync_status":
          return callResult(await getSyncStatus(a));
        default:
          return callResult({ ok: false, message: `Unknown tool: ${name}` });
      }
    } catch (error) {
      return callResult({
        ok: false,
        message: `Tool execution failed: ${(error as Error).message}`,
      });
    }
  });

  return server;
}

function callResult(result: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

async function main() {
  const app = new Hono();

  const mcpServer = createMcpServer();

  // Use WebStandardStreamableHTTPServerTransport — works with Hono's c.req.raw
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await mcpServer.connect(transport);

  // MCP endpoint — Hono all-method route
  app.all("/mcp", async (c) => {
    return transport.handleRequest(c.req.raw);
  });

  // Health check
  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "nextcloud-mcp-server",
      nextcloud: config.nextcloudBaseUrl,
      permissionApi: config.permissionToken ? "enabled" : "disabled",
      database: "configured",
    });
  });

  console.error(`Nextcloud MCP server listening on http://${HOST}:${PORT}`);
  console.error(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
  console.error(`Health check: http://${HOST}:${PORT}/health`);
  console.error(`Nextcloud: ${config.nextcloudBaseUrl}`);
  console.error(`Permission API: ${config.permissionToken ? "enabled" : "disabled"}`);

  serve({
    fetch: app.fetch,
    hostname: HOST,
    port: PORT,
  });
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});