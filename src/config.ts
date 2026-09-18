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
  return Number.isFinite(value) ? value : fallback;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensureTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "") + "/";
}

const maxExtractFileMb = envInt("MAX_EXTRACT_FILE_MB", 20);

export const config = {
  // PostgreSQL
  databaseUrl: requiredEnv("DATABASE_URL"),

  // Nextcloud connection
  nextcloudBaseUrl: stripTrailingSlash(requiredEnv("NEXTCLOUD_BASE_URL")),
  webdavUrl: ensureTrailingSlash(requiredEnv("NEXTCLOUD_WEBDAV_URL")),
  nextcloudUser: requiredEnv("NEXTCLOUD_USER"),
  nextcloudPassword: requiredEnv("NEXTCLOUD_APP_PASSWORD"),

  // Limits
  maxDownloadMb: envInt("MAX_DOWNLOAD_MB", 50),
  maxExtractFileMb,

  // Derived
  maxExtractBytes: maxExtractFileMb * 1024 * 1024,
};

// Re-export config properties for convenience
export const {
  databaseUrl,
  nextcloudBaseUrl,
  webdavUrl,
  nextcloudUser,
  nextcloudPassword,
} = config;