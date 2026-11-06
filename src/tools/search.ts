import { query } from "../db.js";
import { formatBytes, formatDateTime } from "../nextcloud/utils.js";

export interface SearchFilesArgs {
  query: string;
  limit?: number;
  extension?: string;
  folderPath?: string;
}

export async function searchFiles(args: SearchFilesArgs) {
  const searchQuery = String(args.query || "").trim();
  if (!searchQuery) {
    return { ok: false, message: "query is required" };
  }

  const limit = Math.min(Math.max(Number(args.limit || 20), 1), 200);
  const extension = args.extension?.trim().toLowerCase() || null;
  const folderPath = args.folderPath?.trim() || null;

  const conditions: string[] = ["f.is_deleted = FALSE", "f.nextcloud_file_id IS NOT NULL"];
  const params: unknown[] = [];

  // 三个字段都复用同一个 $1，避免 paramIndex 累加错位。
  params.push(`%${searchQuery}%`);
  conditions.push(
    "(f.file_name ILIKE $1 OR f.file_path ILIKE $1 OR f.folder_path ILIKE $1)"
  );

  if (extension) {
    params.push(extension);
    conditions.push(`f.extension = $${params.length}`);
  }

  if (folderPath) {
    params.push(`${folderPath}%`);
    conditions.push(`f.folder_path ILIKE $${params.length}`);
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT
      f.file_name,
      f.nextcloud_file_id,
      f.file_path,
      f.folder_path,
      f.extension,
      f.mime_type,
      f.size_bytes,
      f.last_modified,
      f.web_url
    FROM files_index f
    WHERE ${conditions.join(" AND ")}
    ORDER BY f.last_modified DESC NULLS LAST, f.updated_at DESC
    LIMIT ${limitParam}
  `;

  const result = await query(sql, params);
  const rows = result.rows.slice(0, limit);

  return {
    ok: true,
    query: searchQuery,
    count: rows.length,
    items: rows.map((row: Record<string, unknown>) => ({
      file_id: row.nextcloud_file_id,
      file_name: row.file_name,
      file_path: row.file_path,
      folder_path: row.folder_path,
      extension: row.extension,
      mime_type: row.mime_type,
      size: formatBytes(Number(row.size_bytes || 0)),
      size_bytes: Number(row.size_bytes || 0),
      last_modified: formatDateTime(row.last_modified as string),
      web_url: row.web_url,
    })),
  };
}
