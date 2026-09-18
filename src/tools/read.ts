import { query } from "../db.js";
import { downloadFile } from "../nextcloud/webdav.js";
import { extractTextFromBuffer, isExtractableFile } from "../extractors/text.js";
import { config } from "../config.js";

export interface ReadFileArgs {
  filePath: string;
  maxChars?: number;
  chunkIndex?: number;
}

export async function readFile(args: ReadFileArgs) {
  const filePath = String(args.filePath || "").trim();
  if (!filePath) {
    return { ok: false, message: "filePath is required" };
  }

  const maxChars = Math.min(Math.max(Number(args.maxChars || 50000), 1), 200000);

  // 1. Look up file in files_index
  const fileResult = await query(
    `SELECT file_name, file_path, nextcloud_file_id, extension, mime_type,
            size_bytes, dav_url, etag
     FROM files_index
     WHERE file_path = $1 AND is_deleted = FALSE
     LIMIT 1`,
    [filePath]
  );

  if (!fileResult.rows.length) {
    return { ok: false, message: `File not found in index: ${filePath}` };
  }

  const file = fileResult.rows[0] as Record<string, unknown>;

  // 2. Try cached text from document_texts
  const existing = await query(
    `SELECT content_text, content_hash, extract_status
     FROM document_texts
     WHERE file_path = $1`,
    [filePath]
  );

  if (existing.rows[0]?.extract_status === "success" && existing.rows[0]?.content_text) {
    const text = String(existing.rows[0].content_text);
    const truncated = text.slice(0, maxChars);
    return {
      ok: true,
      file_name: file.file_name,
      file_path: file.file_path,
      extension: file.extension,
      mime_type: file.mime_type,
      size_bytes: Number(file.size_bytes || 0),
      source: "cached",
      content: truncated,
      charCount: truncated.length,
      totalChars: text.length,
      truncated: truncated.length < text.length,
    };
  }

  // 3. Not cached or not text-extractable -> download via WebDAV
  const extension = String(file.extension || "");
  if (!isExtractableFile(extension)) {
    return {
      ok: false,
      message: `File type "${extension}" is not text-extractable. Use nextcloud_download_file for binary content.`,
      file_name: file.file_name,
      file_path: file.file_path,
      extension: file.extension,
      mime_type: file.mime_type,
      size_bytes: Number(file.size_bytes || 0),
    };
  }

  // 4. Size check
  if (Number(file.size_bytes || 0) > config.maxExtractBytes) {
    return {
      ok: false,
      message: `File is larger than ${config.maxExtractFileMb}MB limit. Use nextcloud_download_file instead.`,
      file_name: file.file_name,
      file_path: file.file_path,
      extension: file.extension,
      size_bytes: Number(file.size_bytes || 0),
    };
  }

  try {
    const davUrl = String(file.dav_url || "");
    if (!davUrl) {
      return { ok: false, message: "No DAV URL available for this file" };
    }

    const buffer = await downloadFile(davUrl);
    const contentText = await extractTextFromBuffer(buffer, extension);
    if (!contentText.trim()) {
      return { ok: false, message: "No text could be extracted from this file" };
    }

    const truncated = contentText.slice(0, maxChars);
    return {
      ok: true,
      file_name: file.file_name,
      file_path: file.file_path,
      extension: file.extension,
      mime_type: file.mime_type,
      size_bytes: Number(file.size_bytes || 0),
      source: "live",
      content: truncated,
      charCount: truncated.length,
      totalChars: contentText.length,
      truncated: truncated.length < contentText.length,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Failed to download/extract file: ${(error as Error).message}`,
      file_name: file.file_name,
      file_path: file.file_path,
    };
  }
}