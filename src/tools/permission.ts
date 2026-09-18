import { checkPermissions } from "../nextcloud/permission.js";

export interface CheckPermissionArgs {
  userId: string;
  fileIds: string[];
}

export async function checkPermissionTool(args: CheckPermissionArgs) {
  const userId = String(args.userId || "").trim();
  if (!userId) {
    return { ok: false, message: "userId is required" };
  }

  if (!Array.isArray(args.fileIds) || !args.fileIds.length) {
    return { ok: false, message: "fileIds array is required" };
  }

  if (args.fileIds.length > 200) {
    return { ok: false, message: "Maximum 200 fileIds per request" };
  }

  const perms = await checkPermissions(userId, args.fileIds);

  const items = args.fileIds.map((fileId) => {
    const perm = perms.get(fileId);
    return {
      fileId,
      canRead: perm?.canRead || false,
      userPath: perm?.userPath || null,
    };
  });

  return {
    ok: true,
    userId,
    items,
    summary: {
      total: items.length,
      readable: items.filter((item) => item.canRead).length,
      denied: items.filter((item) => !item.canRead).length,
    },
  };
}