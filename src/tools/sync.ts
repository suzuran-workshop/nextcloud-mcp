import { query } from "../db.js";

export interface SyncStatusArgs {
  limit?: number;
}

export async function getSyncStatus(args: SyncStatusArgs) {
  const limit = Math.min(Math.max(Number(args.limit || 5), 1), 20);

  const result = await query(
    `SELECT id, status, started_at, finished_at,
            scanned_count, created_count, updated_count, deleted_count,
            error_message
     FROM sync_runs
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit]
  );

  return {
    ok: true,
    recentRuns: result.rows.map((row: Record<string, unknown>) => ({
      id: row.id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      scannedCount: Number(row.scanned_count || 0),
      createdCount: Number(row.created_count || 0),
      updatedCount: Number(row.updated_count || 0),
      deletedCount: Number(row.deleted_count || 0),
      errorMessage: row.error_message || null,
    })),
  };
}