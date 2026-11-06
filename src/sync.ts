import { query, getClient } from "./db.js";
import { config } from "./config.js";
import { propfind, downloadFile, davUrlForPath, WebdavEntry } from "./nextcloud/webdav.js";
import { extractTextFromBuffer, isExtractableFile, normalizeExtractedText, chunkText } from "./extractors/text.js";
import { rebuildEmbeddings } from "./nextcloud/ai.js";

export interface SyncState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  lastResult: Record<string, unknown> | null;
}

export const syncState: SyncState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  lastResult: null,
};

export interface SyncOptions {
  extractText?: boolean;
  rebuildVectors?: boolean;
}

interface Counters {
  scanned: number;
  created: number;
  updated: number;
  deleted: number;
  extracted: number;
  extractFailed: number;
  directories: number;
  errors: string[];
}

/** 全量同步 ai_reader 可见范围：PROPFIND 遍历 → files_index → 正文/chunk → 向量补齐。 */
export async function runSync(options: SyncOptions = {}): Promise<Record<string, unknown>> {
  if (syncState.running) {
    return { ok: false, message: "sync already running", startedAt: syncState.startedAt };
  }
  syncState.running = true;
  syncState.startedAt = new Date().toISOString();
  syncState.finishedAt = null;

  const counters: Counters = {
    scanned: 0, created: 0, updated: 0, deleted: 0,
    extracted: 0, extractFailed: 0, directories: 0, errors: [],
  };
  const startedAt = new Date();
  let syncRunId: number | null = null;

  try {
    const run = await query(
      "INSERT INTO sync_runs (status, started_at) VALUES ('running', NOW()) RETURNING id",
    );
    syncRunId = Number((run.rows[0] as { id: number }).id);

    // 迭代 BFS，避免深层目录递归爆栈；单目录失败只记录不中断整体。
    const queue: Array<{ url: string; depth: number }> = [
      { url: config.webdavUrl, depth: 0 },
    ];
    const visited = new Set<string>();
    const seenPaths = new Set<string>();

    while (queue.length > 0) {
      if (Date.now() - startedAt.getTime() > config.syncTimeoutMs) {
        counters.errors.push("sync timeout reached, remaining folders skipped");
        break;
      }
      const current = queue.shift()!;
      const key = current.url.replace(/\/+$/, "");
      if (visited.has(key)) continue;
      visited.add(key);

      let entries: WebdavEntry[];
      try {
        entries = await propfind(current.url);
      } catch (error) {
        counters.errors.push(`${current.url}: ${(error as Error).message}`);
        continue;
      }

      for (const entry of entries) {
        if (!entry.path || entry.path === "/") continue;
        const normalized = entry.url.replace(/\/+$/, "");
        if (normalized === key) continue;

        if (entry.isDirectory) {
          counters.directories += 1;
          if (current.depth < config.syncMaxDepth) {
            queue.push({ url: entry.url, depth: current.depth + 1 });
          }
          continue;
        }

        counters.scanned += 1;
        seenPaths.add(entry.path);
        try {
          const written = await upsertFile(entry);
          if (written === "created") counters.created += 1;
          else counters.updated += 1;

          if (options.extractText !== false) {
            const result = await extractAndStore(entry);
            if (result === "success") counters.extracted += 1;
            if (result === "failed") counters.extractFailed += 1;
          }
        } catch (error) {
          counters.errors.push(`${entry.path}: ${(error as Error).message}`);
        }
      }
    }

    // 未被本次遍历到的行标记删除；不物理删除，保留历史缓存。
    const deleted = await query(
      `UPDATE files_index SET is_deleted = TRUE, deleted_at = NOW(), updated_at = NOW()
       WHERE is_deleted = FALSE AND updated_at < $1
       RETURNING id`,
      [startedAt],
    );
    counters.deleted = deleted.rowCount || 0;

    let embedding: Record<string, unknown> | null = null;
    if (options.rebuildVectors !== false && counters.extracted > 0) {
      try {
        embedding = await rebuildEmbeddings();
      } catch (error) {
        counters.errors.push(`embedding rebuild: ${(error as Error).message}`);
      }
    }

    await query(
      `UPDATE sync_runs SET status='success', finished_at=NOW(),
        scanned_count=$2, created_count=$3, updated_count=$4, deleted_count=$5
       WHERE id=$1`,
      [syncRunId, counters.scanned, counters.created, counters.updated, counters.deleted],
    );

    const result = {
      ok: true,
      syncRunId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ...counters,
      embedding,
    };
    syncState.lastResult = result;
    syncState.finishedAt = result.finishedAt;
    return result;
  } catch (error) {
    const message = (error as Error).stack || (error as Error).message;
    if (syncRunId !== null) {
      await query(
        "UPDATE sync_runs SET status='failed', finished_at=NOW(), error_message=$2 WHERE id=$1",
        [syncRunId, message],
      ).catch(() => {});
    }
    const result = { ok: false, syncRunId, error: message, ...counters };
    syncState.lastResult = result;
    syncState.finishedAt = new Date().toISOString();
    return result;
  } finally {
    syncState.running = false;
  }
}

async function upsertFile(entry: WebdavEntry): Promise<"created" | "updated"> {
  const result = await query(
    `INSERT INTO files_index (
       nextcloud_file_id, etag, file_name, file_path, folder_path,
       extension, mime_type, size_bytes, last_modified, web_url, dav_url,
       source, is_deleted, deleted_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'nextcloud',FALSE,NULL,NOW())
     ON CONFLICT (file_path) DO UPDATE SET
       nextcloud_file_id = EXCLUDED.nextcloud_file_id,
       etag = EXCLUDED.etag,
       file_name = EXCLUDED.file_name,
       folder_path = EXCLUDED.folder_path,
       extension = EXCLUDED.extension,
       mime_type = EXCLUDED.mime_type,
       size_bytes = EXCLUDED.size_bytes,
       last_modified = EXCLUDED.last_modified,
       web_url = EXCLUDED.web_url,
       dav_url = EXCLUDED.dav_url,
       is_deleted = FALSE,
       deleted_at = NULL,
       updated_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [
      entry.nextcloudFileId,
      entry.etag,
      entry.fileName,
      entry.path,
      entry.folderPath,
      entry.extension,
      entry.mimeType,
      entry.sizeBytes,
      entry.lastModified,
      entry.webUrl,
      davUrlForPath(entry.path),
    ],
  );
  return (result.rows[0] as { inserted: boolean })?.inserted ? "created" : "updated";
}

async function extractAndStore(entry: WebdavEntry): Promise<"skip" | "unchanged" | "success" | "failed"> {
  if (!isExtractableFile(entry.extension)) return "skip";
  if (entry.sizeBytes > config.maxExtractBytes) return "skip";

  const contentHash = entry.etag || `${entry.sizeBytes}:${entry.lastModified?.toISOString?.() || ""}`;
  const existing = await query(
    "SELECT content_hash, extract_status FROM document_texts WHERE file_path = $1",
    [entry.path],
  );
  const row = existing.rows[0] as { content_hash: string; extract_status: string } | undefined;
  if (row?.content_hash === contentHash && row?.extract_status === "success") return "unchanged";

  try {
    const buffer = await downloadFile(davUrlForPath(entry.path));
    const text = normalizeExtractedText(await extractTextFromBuffer(buffer, entry.extension));
    if (!text) {
      await writeTextStatus(entry, contentHash, "empty", "no text extracted");
      await query("DELETE FROM document_chunks WHERE file_path = $1", [entry.path]);
      return "skip";
    }
    const chunks = chunkText(text);
    await writeTextAndChunks(entry, contentHash, text, chunks);
    return "success";
  } catch (error) {
    await writeTextStatus(entry, contentHash, "failed", (error as Error).message);
    return "failed";
  }
}

async function writeTextStatus(
  entry: WebdavEntry,
  contentHash: string,
  status: string,
  errorMessage: string,
): Promise<void> {
  await query(
    `INSERT INTO document_texts (
       file_path, file_name, extension, mime_type, content_hash,
       extract_status, error_message, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (file_path) DO UPDATE SET
       file_name=EXCLUDED.file_name, extension=EXCLUDED.extension,
       mime_type=EXCLUDED.mime_type, content_hash=EXCLUDED.content_hash,
       extract_status=EXCLUDED.extract_status, error_message=EXCLUDED.error_message,
       updated_at=NOW()`,
    [entry.path, entry.fileName, entry.extension, entry.mimeType, contentHash, status, errorMessage],
  );
}

async function writeTextAndChunks(
  entry: WebdavEntry,
  contentHash: string,
  text: string,
  chunks: string[],
): Promise<void> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO document_texts (
         file_path, file_name, extension, mime_type, content_text, content_hash,
         extract_status, error_message, extracted_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'success',NULL,NOW(),NOW())
       ON CONFLICT (file_path) DO UPDATE SET
         file_name=EXCLUDED.file_name, extension=EXCLUDED.extension,
         mime_type=EXCLUDED.mime_type, content_text=EXCLUDED.content_text,
         content_hash=EXCLUDED.content_hash, extract_status='success',
         error_message=NULL, extracted_at=NOW(), updated_at=NOW()`,
      [entry.path, entry.fileName, entry.extension, entry.mimeType, text, contentHash],
    );
    await client.query("DELETE FROM document_chunks WHERE file_path = $1", [entry.path]);
    for (let i = 0; i < chunks.length; i += 1) {
      await client.query(
        "INSERT INTO document_chunks (file_path, chunk_index, chunk_text) VALUES ($1,$2,$3)",
        [entry.path, i, chunks[i]],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
