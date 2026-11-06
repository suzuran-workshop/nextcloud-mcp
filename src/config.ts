import dotenv from "dotenv";

dotenv.config();

function env(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function envInt(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensureTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "") + "/";
}

const maxExtractFileMb = envInt("MAX_EXTRACT_FILE_MB", 20);

export const config = {
  // 服务
  port: envInt("PORT", 3101),
  host: env("HOST", "0.0.0.0"),

  // PostgreSQL（与 meidong-ai-assistant 共用同一个库）
  databaseUrl: requiredEnv("DATABASE_URL"),

  // Nextcloud 服务账号
  nextcloudBaseUrl: stripTrailingSlash(requiredEnv("NEXTCLOUD_BASE_URL")),
  webdavUrl: ensureTrailingSlash(requiredEnv("NEXTCLOUD_WEBDAV_URL")),
  nextcloudUser: requiredEnv("NEXTCLOUD_USER"),
  nextcloudPassword: requiredEnv("NEXTCLOUD_APP_PASSWORD"),

  // 问数转发（meidong-ai-assistant 的 /api/ask 等）
  aiBaseUrl: stripTrailingSlash(env("AI_BASE_URL", "http://meidong-ai-assistant:3100")),
  aiInternalApiToken: env("AI_INTERNAL_API_TOKEN", ""),
  aiUserId: env("AI_USER_ID", "ai_reader"),

  // 自建同步
  autoSyncOnStart: env("AUTO_SYNC_ON_START", "true").toLowerCase() === "true",
  autoSyncIntervalMinutes: envInt("AUTO_SYNC_INTERVAL_MINUTES", 120),
  syncTimeoutMs: envInt("SYNC_TIMEOUT_MS", 1_200_000),
  syncMaxDepth: envInt("SYNC_MAX_DEPTH", 20),

  // 限制
  maxDownloadMb: envInt("MAX_DOWNLOAD_MB", 50),
  maxExtractFileMb,
  maxExtractBytes: maxExtractFileMb * 1024 * 1024,
};

export const {
  databaseUrl,
  nextcloudBaseUrl,
  webdavUrl,
  nextcloudUser,
  nextcloudPassword,
} = config;
