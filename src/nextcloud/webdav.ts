import { XMLParser } from "fast-xml-parser";
import { basicAuth, toArray, hrefToFullUrl, hrefToUserPath, parentPath, getExtension, cleanEtag, buildWebUrl } from "./utils.js";
import { webdavUrl } from "../config.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
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

/**
 * Perform a WebDAV PROPFIND request to list files in a directory.
 */
export async function propfind(url?: string): Promise<WebdavEntry[]> {
  const targetUrl = url || webdavUrl;

  const response = await fetch(targetUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuth(),
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:getlastmodified />
    <d:getcontentlength />
    <d:getcontenttype />
    <d:getetag />
    <d:resourcetype />
    <oc:fileid />
  </d:prop>
</d:propfind>`,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WebDAV PROPFIND failed ${response.status}: ${text.slice(0, 500)}`);
  }

  const xml = await response.text();
  const parsed = xmlParser.parse(xml);
  const responses = toArray(parsed?.multistatus?.response);

  return responses.map(parseWebdavResponse).filter((e): e is WebdavEntry => e !== null);
}

function parseWebdavResponse(item: Record<string, unknown>): WebdavEntry | null {
  const href = item.href as string | undefined;
  if (!href) return null;

  const propstatArray = toArray(item.propstat as Record<string, unknown>[] | Record<string, unknown>);
  const propstat = propstatArray.find((entry) => {
    const status = String(entry?.status || "");
    return status.includes("200");
  }) || propstatArray[0];

  if (!propstat) return null;

  const prop = (propstat as Record<string, unknown>).prop as Record<string, unknown> || {};
  const resourcetype = prop.resourcetype as Record<string, unknown> | undefined;
  const isDirectory = resourcetype?.collection !== undefined;
  const fullUrl = hrefToFullUrl(href);
  const path = hrefToUserPath(href);
  const fileName = path.split("/").filter(Boolean).pop() || "";
  const folderPath = parentPath(path);
  const extension = getExtension(fileName);

  return {
    url: fullUrl,
    path,
    fileName,
    folderPath,
    extension,
    isDirectory,
    nextcloudFileId: prop.fileid ? String(prop.fileid) : null,
    etag: cleanEtag(prop.getetag),
    mimeType: (prop.getcontenttype as string) || null,
    sizeBytes: Number(prop.getcontentlength || 0),
    lastModified: prop.getlastmodified ? new Date(prop.getlastmodified as string) : null,
    webUrl: buildWebUrl(path),
    davUrl: fullUrl,
  };
}

/**
 * Download a file via WebDAV GET.
 */
export async function downloadFile(davUrl: string): Promise<Buffer> {
  const response = await fetch(davUrl, {
    method: "GET",
    headers: {
      Authorization: basicAuth(),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WebDAV download failed ${response.status}: ${text.slice(0, 300)}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Recursively walk the WebDAV tree and return all files.
 */
export async function walkWebdav(
  url?: string,
  entries: WebdavEntry[] = []
): Promise<WebdavEntry[]> {
  try {
    const items = await propfind(url);
    const currentUrl = (url || webdavUrl).replace(/\/+$/, "");

    for (const item of items) {
      if (item.url.replace(/\/+$/, "") === currentUrl) continue;
      if (!item.path || item.path === "/") continue;

      if (item.isDirectory) {
        await walkWebdav(item.url, entries);
      } else {
        entries.push(item);
      }
    }
  } catch (error) {
    // Log but continue for live listing
    console.error("WebDAV walk error:", (error as Error).message);
  }

  return entries;
}