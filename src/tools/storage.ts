import { getPersonStorage } from "../nextcloud/permission.js";
import { query } from "../db.js";
import { formatBytes } from "../nextcloud/utils.js";

export interface StorageStatsArgs {
  userId: string;
  targetUserId?: string;
}

export async function getStorageStats(args: StorageStatsArgs) {
  const userId = String(args.userId || "").trim();
  if (!userId) {
    return { ok: false, message: "userId is required" };
  }

  try {
    const result = await getPersonStorage(userId, args.targetUserId);

    if (!result.found) {
      return {
        ok: true,
        found: false,
        message: result.message || "User not found or storage info unavailable",
        status: result.status,
      };
    }

    return {
      ok: true,
      found: true,
      user: result.user,
      usage: result.usage
        ? {
            ...result.usage,
            usedFormatted: formatBytes(result.usage.usedBytes),
            totalFormatted: result.usage.totalBytes !== null
              ? formatBytes(result.usage.totalBytes)
              : "unlimited",
            freeFormatted: result.usage.freeBytes !== null
              ? formatBytes(result.usage.freeBytes)
              : null,
          }
        : null,
    };
  } catch (error) {
    // Fallback: summarize from files_index
    const summary = await query(
      `SELECT
         COUNT(*)::int AS file_count,
         COUNT(DISTINCT folder_path)::int AS folder_count,
         COALESCE(SUM(size_bytes), 0)::bigint AS total_size,
         MAX(last_modified) AS latest_modified
       FROM files_index
       WHERE is_deleted = FALSE`
    );

    const row = summary.rows[0] as Record<string, unknown>;
    return {
      ok: true,
      found: true,
      source: "index_summary",
      usage: {
        fileCount: row.file_count,
        folderCount: row.folder_count,
        totalSize: Number(row.total_size || 0),
        totalFormatted: formatBytes(Number(row.total_size || 0)),
        latestModified: row.latest_modified
          ? new Date(row.latest_modified as string).toISOString()
          : null,
      },
      note: "Personal storage API unavailable. Showing index-level summary.",
    };
  }
}