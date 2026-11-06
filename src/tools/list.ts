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
}

export async function listDirectory(args: ListDirectoryArgs) {
  const raw = String(args.path || "/").trim();
  const normalizedPath = raw === "/" ? "/" : `/${raw.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  const recursive = Boolean(args.recursive);
  const limit = Math.min(Math.max(Number(args.limit || 100), 1), 500);

  const prefix = normalizedPath === "/" ? "/" : `${normalizedPath}/`;
  const dirDepth = normalizedPath.split("/").filter(Boolean).length + 2;

  const fileSql = recursive
    ? `SELECT file_name, nextcloud_file_id, file_path, folder_path, extension,
              mime_type, size_bytes, last_modified, web_url
       FROM files_index
       WHERE is_deleted = FALSE AND nextcloud_file_id IS NOT NULL
         AND starts_with(file_path, $1)
       ORDER BY file_path ASC
       LIMIT $2`
    : `SELECT file_name, nextcloud_file_id, file_path, folder_path, extension,
              mime_type, size_bytes, last_modified, web_url
       FROM files_index
       WHERE is_deleted = FALSE AND nextcloud_file_id IS NOT NULL
         AND folder_path = $1
       ORDER BY file_name ASC
       LIMIT $2`;

  const fileParams: unknown[] = recursive
    ? [prefix, limit]
    : [normalizedPath, limit];

  const fileResult = await query(fileSql, fileParams);
  const files = (fileResult.rows as FileRow[]).map((row) => ({
    name: row.file_name,
    type: "file",
    file_id: row.nextcloud_file_id,
    file_path: row.file_path,
    extension: row.extension,
    mime_type: row.mime_type,
    size: formatBytes(Number(row.size_bytes || 0)),
    size_bytes: Number(row.size_bytes || 0),
    last_modified: formatDateTime(row.last_modified),
    web_url: row.web_url,
  }));

  const dirs: Array<Record<string, unknown>> = [];
  if (!recursive) {
    // 直接子目录：取所有以 prefix 开头的路径的第 dirDepth 个斜杠分段。
    const dirResult = await query(
      `SELECT DISTINCT SPLIT_PART(file_path, '/', $2) AS name
       FROM files_index
       WHERE is_deleted = FALSE
         AND starts_with(file_path, $1)
         AND SPLIT_PART(file_path, '/', $2) <> ''
       ORDER BY name ASC
       LIMIT $3`,
      [prefix, dirDepth, limit]
    );
    for (const row of dirResult.rows as Array<{ name: string }>) {
      const childPath = normalizedPath === "/"
        ? `/${row.name}`
        : `${normalizedPath}/${row.name}`;
      dirs.push({
        name: row.name,
        type: "directory",
        file_id: null,
        file_path: childPath,
        extension: "",
        mime_type: "httpd/unix-directory",
        size: "0 B",
        size_bytes: 0,
        last_modified: "",
        web_url: null,
      });
    }
  }

  const items = [...dirs, ...files].slice(0, limit);
  return {
    ok: true,
    path: normalizedPath,
    recursive,
    count: items.length,
    directoryCount: dirs.length,
    fileCount: files.length,
    items,
  };
}
