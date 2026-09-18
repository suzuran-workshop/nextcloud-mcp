import { permissionUrl, personStorageUrl, permissionToken, nextcloudBaseUrl } from "../config.js";

export interface PermissionItem {
  fileId: string;
  canRead: boolean;
  userPath: string;
}

/**
 * Batch-check file read permissions for a Nextcloud user.
 * Calls the school_ai_permission app API.
 */
export async function checkPermissions(
  userId: string,
  fileIds: string[]
): Promise<Map<string, PermissionItem>> {
  if (!permissionToken) {
    throw new Error("NEXTCLOUD_PERMISSION_TOKEN is not configured");
  }

  const byFileId = new Map<string, PermissionItem>();
  const batches: string[][] = [];

  for (let offset = 0; offset < fileIds.length; offset += 200) {
    batches.push(fileIds.slice(offset, offset + 200));
  }
  if (!batches.length) batches.push([]);

  for (const batch of batches) {
    const response = await fetch(permissionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${permissionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId,
        fileIds: batch,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const body = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) {
      throw new Error(`Nextcloud permission check failed ${response.status}`);
    }
    if ((body as Record<string, unknown>).userValid !== true) {
      throw new Error("Nextcloud user is missing or disabled");
    }

    const items = Array.isArray((body as Record<string, unknown>).items)
      ? (body as Record<string, unknown>).items as Array<Record<string, unknown>>
      : [];

    for (const item of items) {
      const fileId = String(item.fileId || "");
      if (!batch.includes(fileId)) continue;
      byFileId.set(fileId, {
        fileId,
        canRead: item.canRead === true,
        userPath: item.canRead === true ? String(item.userPath || "") : "",
      });
    }
  }

  return byFileId;
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function buildWebUrl(path: string): string {
  if (!path || path === "/") return `${nextcloudBaseUrl}/apps/files/`;
  const folder = parentPath(path);
  const fileName = path.split("/").filter(Boolean).pop() || "";
  const dirParam = encodeURIComponent(folder === "/" ? "/" : folder);
  const fileParam = encodeURIComponent(fileName);
  return `${nextcloudBaseUrl}/apps/files/?dir=${dirParam}&openfile=${fileParam}`;
}

interface FileRow {
  file_path?: string | null;
  folder_path?: string | null;
  nextcloud_file_id?: string | null;
  web_url?: string | null;
  [key: string]: unknown;
}

/**
 * Filter candidate rows through the permission check API.
 * Returns only rows the user can read, with userPath applied.
 */
export async function authorizeCandidateRows<T extends FileRow>(
  userId: string,
  rows: T[],
  limit?: number
): Promise<T[]> {
  if (!rows.length) return [];

  const validRows = rows.filter((row) =>
    /^\d+$/.test(String(row.nextcloud_file_id || ""))
  );
  const uniqueFileIds = [...new Set(validRows.map((row) => String(row.nextcloud_file_id)))];

  if (!uniqueFileIds.length) return rows.slice(0, limit);

  const permissionByFileId = await checkPermissions(userId, uniqueFileIds);
  const maxResults = limit ?? rows.length;

  const authorized: T[] = [];
  for (const row of validRows) {
    const permission = permissionByFileId.get(String(row.nextcloud_file_id));
    if (!permission?.canRead) continue;

    const authorizedRow = { ...row };
    if (permission.userPath) {
      authorizedRow.file_path = permission.userPath;
      authorizedRow.folder_path = parentPath(permission.userPath);
      authorizedRow.web_url = buildWebUrl(permission.userPath);
    }
    authorized.push(authorizedRow);
    if (authorized.length >= maxResults) break;
  }

  return authorized;
}

export interface StorageStatsResult {
  found: boolean;
  ambiguous?: boolean;
  user?: { userId: string; displayName: string };
  usage?: {
    usedBytes: number;
    totalBytes: number | null;
    freeBytes: number | null;
    quotaUnlimited?: boolean;
    percentage: number | null;
  };
  status?: string;
  message?: string;
  error?: string;
}

/**
 * Get personal storage stats for a user.
 */
export async function getPersonStorage(
  requesterUserId: string,
  target?: string
): Promise<StorageStatsResult> {
  if (!permissionToken) {
    throw new Error("NEXTCLOUD_PERMISSION_TOKEN is not configured");
  }

  const response = await fetch(personStorageUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${permissionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requesterUserId,
      target: target || "",
    }),
    signal: AbortSignal.timeout(15000),
  });

  const body = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok && response.status >= 500) {
    throw new Error(`Nextcloud personal storage lookup failed ${response.status}`);
  }
  if (!response.ok) {
    return {
      found: false,
      status: (body as Record<string, unknown>).error as string || "lookup_failed",
      message: (body as Record<string, unknown>).message as string || "",
    };
  }
  return body as unknown as StorageStatsResult;
}