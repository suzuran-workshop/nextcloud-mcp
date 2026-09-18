import { query } from "../db.js";
import { downloadFile } from "../nextcloud/webdav.js";
import { checkPermissions } from "../nextcloud/permission.js";
import { config } from "../config.js";

export interface DownloadFileArgs {
  filePath: string;
  userId?: string;
}

export async function downloadFileTool(args: DownloadFileArgs) {
  const filePath = String(args.filePath || "").trim();
  if (!filePath) {
    return { ok: false, message: "filePath is required" };
  }

  // Look up file in index
  const fileResult = await query(
    `SELECT file_name, file_path, nextcloud_file_id, extension, mime_type,
            size_bytes, dav_url
     FROM files_index
     WHERE file_path = $1 AND is_deleted = FALSE
     LIMIT 1`,
    [filePath]
  );

  if (!fileResult.rows.length) {
    return { ok: false, message: `File not found in index: ${filePath}` };
  }

  const file = fileResult.rows[0] as Record<string, unknown>;

  // Permission check
  if (args.userId && file.nextcloud_file_id) {
    const perms = await checkPermissions(args.userId, [String(file.nextcloud_file_id)]);
    const perm = perms.get(String(file.nextcloud_file_id));
    if (!perm?.canRead) {
      return { ok: false, message: `User ${args.userId} does not have permission for: ${filePath}` };
    }
  }

  // Size check
  const maxBytes = config.maxDownloadMb * 1024 * 1024;
  if (Number(file.size_bytes || 0) > maxBytes) {
    return {
      ok: false,
      message: `File exceeds ${config.maxDownloadMb}MB download limit`,
      file_name: file.file_name,
      size_bytes: Number(file.size_bytes || 0),
    };
  }

  // Download via WebDAV
  try {
    const davUrl = String(file.dav_url || "");
    if (!davUrl) {
      return { ok: false, message: "No DAV URL available for this file" };
    }

    const buffer = await downloadFile(davUrl);
    const base64 = buffer.toString("base64");

    return {
      ok: true,
      file_name: file.file_name,
      file_path: file.file_path,
      extension: file.extension,
      mime_type: file.mime_type,
      size_bytes: buffer.length,
      base64,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Download failed: ${(error as Error).message}`,
      file_name: file.file_name,
    };
  }
}