import { nextcloudBaseUrl, webdavUrl, nextcloudUser, nextcloudPassword } from "../config.js";

export function basicAuth(): string {
  return `Basic ${Buffer.from(`${nextcloudUser}:${nextcloudPassword}`).toString("base64")}`;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

export function getExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  if (index === -1 || index === fileName.length - 1) return "";
  return fileName.slice(index + 1).toLowerCase();
}

export function cleanEtag(value: unknown): string | null {
  if (!value) return null;
  return String(value).replace(/^"|"$/g, "");
}

export function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Convert a WebDAV href to the user-relative path.
 * The admin WebDAV URL has the form: /remote.php/dav/files/<admin_user>/...
 * We strip everything up to and including the admin user segment.
 */
export function hrefToUserPath(href: string): string {
  const fullUrl = hrefToFullUrl(href);
  const parsed = new URL(fullUrl);
  const decodedPath = decodeURIComponent(parsed.pathname);
  const prefix = `/remote.php/dav/files/${nextcloudUser}`;
  let path = decodedPath.startsWith(prefix)
    ? decodedPath.slice(prefix.length)
    : decodedPath;

  path = path || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path;
}

export function hrefToFullUrl(href: string): string {
  const webdavBase = new URL(webdavUrl);
  const resolved = new URL(href, webdavBase);
  resolved.protocol = webdavBase.protocol;
  resolved.host = webdavBase.host;
  return resolved.toString();
}

/**
 * Build a user-facing Nextcloud web URL for a file.
 */
export function buildWebUrl(path: string): string {
  if (!path || path === "/") {
    return `${nextcloudBaseUrl}/apps/files/`;
  }
  const folder = parentPath(path);
  const fileName = path.split("/").filter(Boolean).pop() || "";
  const dirParam = encodeURIComponent(folder === "/" ? "/" : folder);
  const fileParam = encodeURIComponent(fileName);
  return `${nextcloudBaseUrl}/apps/files/?dir=${dirParam}&openfile=${fileParam}`;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatDateTime(value: string | Date | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace("T", " ").slice(0, 19);
}