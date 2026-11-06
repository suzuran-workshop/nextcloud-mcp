import { XMLParser } from "fast-xml-parser";
import {
  basicAuth,
  toArray,
  hrefToUserPath,
  parentPath,
  getExtension,
  cleanEtag,
  buildWebUrl,
  buildDavUrl,
  decodeXmlEntities,
} from "./utils.js";
import { webdavUrl } from "../config.js";

/**
 * 关闭 fast-xml-parser 的实体处理：Nextcloud 的 PROPFIND 响应里
 * 文件名带 & 时，实体展开会累计超过 maxTotalExpansions(1000) 并抛错
 * （meidong-ai-assistant 的同步就是死在这里）。关闭后由 decodeXmlEntities
 * 手动还原标准实体。
 */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  processEntities: false,
  trimValues: false,
});

export interface WebdavEntry {
  url: string;
  path: string;
  fileName: string;
  folderPath: string;
  extension: string;
  isDirectory: boolean;
  nextcloudFileId: string | null;
  etag: string | null;
  mimeType: string | null;
  sizeBytes: number;
  lastModified: Date | null;
  webUrl: string;
  davUrl: string;
}

const PROPFIND_BODY = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:getlastmodified />
    <d:getcontentlength />
    <d:getcontenttype />
    <d:getetag />
    <d:resourcetype />
    <oc:fileid />
  </d:prop>
</d:propfind>`;

export async function propfind(url?: string, timeoutMs = 60_000): Promise<WebdavEntry[]> {
  const targetUrl = url || webdavUrl;

  const response = await fetch(targetUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuth(),
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: PROPFIND_BODY,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WebDAV PROPFIND failed ${response.status}: ${text.slice(0, 500)}`);
  }

  const xml = await response.text();
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;
  const multistatus = parsed?.multistatus as Record<string, unknown> | undefined;
  const responses = toArray(multistatus?.response as Record<string, unknown>[] | Record<string, unknown>);

  return responses
    .map(parseWebdavResponse)
    .filter((e): e is WebdavEntry => e !== null);
}

function parseWebdavResponse(item: Record<string, unknown>): WebdavEntry | null {
  const rawHref = item?.href;
  if (typeof rawHref !== "string" || !rawHref) return null;
  const href = decodeXmlEntities(rawHref);

  const propstatArray = toArray(item.propstat as Record<string, unknown>[] | Record<string, unknown>);
  const propstat = propstatArray.find((entry) => {
    const status = String((entry as Record<string, unknown>)?.status || "");
    return status.includes("200");
  }) || propstatArray[0];

  if (!propstat) return null;
  const prop = ((propstat as Record<string, unknown>).prop as Record<string, unknown>) || {};
  const resourcetype = prop.resourcetype as Record<string, unknown> | undefined;
  const isDirectory = resourcetype?.collection !== undefined;

  // 不再用 href 反推完整 URL：href 里的 &amp; 已解码，交给 buildDavUrl
  // 按 path 重新编码，避免中文/& 文件名在二次解码后错位。
  const path = hrefToUserPath(href);
  const fileName = path.split("/").filter(Boolean).pop() || "";
  const folderPath = parentPath(path);
  const extension = getExtension(fileName);
  const fullUrl = buildDavUrl(path) + (isDirectory ? "/" : "");

  return {
    url: fullUrl,
    path,
    fileName: decodeXmlEntities(fileName),
    folderPath,
    extension,
    isDirectory,
    nextcloudFileId: prop.fileid != null ? String(prop.fileid) : null,
    etag: cleanEtag(prop.getetag),
    mimeType: prop.getcontenttype != null ? String(prop.getcontenttype) : null,
    sizeBytes: Number(prop.getcontentlength || 0),
    lastModified: prop.getlastmodified
      ? new Date(String(prop.getlastmodified))
      : null,
    webUrl: buildWebUrl(path),
    davUrl: fullUrl,
  };
}

export async function downloadFile(davUrl: string, timeoutMs = 120_000): Promise<Buffer> {
  const response = await fetch(davUrl, {
    method: "GET",
    headers: { Authorization: basicAuth() },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WebDAV download failed ${response.status}: ${text.slice(0, 300)}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export function davUrlForPath(path: string): string {
  return buildDavUrl(path);
}
