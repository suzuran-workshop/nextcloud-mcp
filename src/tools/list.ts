import { query } from "../db.js";
import { formatBytes, formatDateTime } from "../nextcloud/utils.js";

export interface ListDirectoryArgs {
  path?: string;
  recursive?: boolean;
  limit?: number;
}

interface FileRow {
  file_name: string;
  nextcloud_file_id: string | null;
  file_path: string;
  folder_path: string;
  extension: string;
  mime_type: string | null;
  size_bytes: string | number;
  last_modified: string | null;
  web_url: string | null;
  is_directory: boolean;
}

export async function listDirectory(args: ListDirectoryArgs) {
  const dirPath = String(args.path || "/").trim();
  const normalizedPath = dirPath === "/" ? "/" : `/${dirPath.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  const recursive = Boolean(args.recursive);
  const limit = Math.min(Math.max(Number(args.limit || 100), 1), 500);

  let sql: string;
  const params: string[] = [];

  if (recursive) {
    sql = `
      SELECT DISTINCT ON (f.file_path)
        f.file_name,
        f.nextcloud_file_id,
        f.file_path,
        f.folder_path,
        f.extension,
        f.mime_type,
        f.size_bytes,
        f.last_modified,
        f.web_url,
        FALSE AS is_directory
      FROM files_index f
      WHERE f.is_deleted = FALSE
        AND f.nextcloud_file_id IS NOT NULL
        AND (f.file_path ILIKE $1 OR f.folder_path ILIKE $1)
      ORDER BY f.file_path, f.last_modified DESC
      LIMIT $2
    `;
    params.push(normalizedPath === "/" ? "/%" : `${normalizedPath}/%`, String(limit));
  } else {
    sql = `
      WITH folder_children AS (
        -- Files directly in this folder
        SELECT
          f.file_name,
          f.nextcloud_file_id,
          f.file_path,
          f.folder_path,
          f.extension,
          f.mime_type,
          f.size_bytes,
          f.last_modified,
          f.web_url,
          FALSE AS is_directory
        FROM files_index f
        WHERE f.is_deleted = FALSE
          AND f.nextcloud_file_id IS NOT NULL
          AND f.folder_path = $1

        UNION ALL

        -- Subdirectories (distinct folder_path values that are direct children)
        SELECT DISTINCT ON (subdir_name)
          subdir_name AS file_name,
          NULL AS nextcloud_file_id,
          subfolder AS file_path,
          $1 AS folder_path,
          '' AS extension,
          'httpd/unix-directory' AS mime_type,
          0 AS size_bytes,
          NULL AS last_modified,
          NULL AS web_url,
          TRUE AS is_directory
        FROM (
          SELECT DISTINCT
            SPLIT_PART(f.file_path, '/', $3) AS subdir_name,
            SPLIT_PART(f.file_path, '/', $3) AS subfolder_segment
          FROM files_index f
          WHERE f.is_deleted = FALSE
            AND f.file_path ILIKE $1 || '/%'
        ) sub
        JOIN files_index f2 ON f2.file_path ILIKE $1 || '/' || sub.subdir_name || '/%'
          AND f2.is_deleted = FALSE
      )
      SELECT * FROM folder_children
      ORDER BY is_directory DESC, file_name ASC
      LIMIT $2
    `;
    const depth = normalizedPath === "/" ? 2 : normalizedPath.split("/").filter(Boolean).length + 2;
    params.push(normalizedPath, String(limit), String(depth));
  }

  const result = await query(sql, params);

  const rows = result.rows.slice(0, limit);

  return {
    ok: true,
    path: normalizedPath,
    recursive,
    count: rows.length,
    items: rows.map((row: FileRow) => ({
      name: row.file_name,
      type: row.is_directory ? "directory" : "file",
      file_id: row.nextcloud_file_id || null,
      file_path: row.file_path,
      extension: row.extension,
      mime_type: row.mime_type,
      size: formatBytes(Number(row.size_bytes || 0)),
      size_bytes: Number(row.size_bytes || 0),
      last_modified: formatDateTime(row.last_modified),
      web_url: row.web_url,
    })),
  };
}