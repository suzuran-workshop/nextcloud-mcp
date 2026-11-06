import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import XLSX from "xlsx";
import JSZip from "jszip";
import { decodeXmlEntities } from "../nextcloud/utils.js";

const TEXT_EXTS = ["txt", "md", "csv"];
const WORD_EXTS = ["docx", "docm"];
const SHEET_EXTS = ["xlsx", "xlsm", "xls"];
const SLIDE_EXTS = ["pptx", "pptm"];

/** 支持的正文抽取格式。doc/ppt 等旧二进制格式保留下载能力，不假装能解析。 */
export function isExtractableFile(extension: string): boolean {
  const ext = String(extension || "").toLowerCase();
  return [
    ...TEXT_EXTS,
    ...WORD_EXTS,
    ...SHEET_EXTS,
    ...SLIDE_EXTS,
    "pdf",
  ].includes(ext);
}

export async function extractTextFromBuffer(
  buffer: Buffer,
  extension: string
): Promise<string> {
  const ext = String(extension || "").toLowerCase();

  if (TEXT_EXTS.includes(ext)) {
    return buffer.toString("utf8");
  }

  if (WORD_EXTS.includes(ext)) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  if (SHEET_EXTS.includes(ext)) {
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
    return workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        blankrows: false,
      }) as unknown[][];
      const text = rows
        .map((row) =>
          row
            .filter((cell) => cell !== null && cell !== undefined && String(cell).trim() !== "")
            .join("\t")
        )
        .filter(Boolean)
        .join("\n");
      return `# ${sheetName}\n${text}`;
    }).join("\n\n");
  }

  if (SLIDE_EXTS.includes(ext)) {
    return extractPptxText(buffer);
  }

  if (ext === "pdf") {
    const result = await pdfParse(buffer);
    return result.text || "";
  }

  return "";
}

async function extractPptxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const an = Number((a.match(/slide(\d+)\.xml$/) || [])[1] || 0);
      const bn = Number((b.match(/slide(\d+)\.xml$/) || [])[1] || 0);
      return an - bn;
    });

  const slides: string[] = [];
  for (const name of slideNames) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async("string");
    const texts = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g))
      .map((match) => decodeXmlEntities(match[1] || ""))
      .map((value) => value.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean);
    if (texts.length) {
      slides.push(`# ${name}\n${texts.join("\n")}`);
    }
  }
  return slides.join("\n\n");
}

export function normalizeExtractedText(value: string): string {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 与 meidong-ai-assistant 保持一致的切块参数，便于复用 pgvector 索引。 */
export function chunkText(text: string, chunkSize = 1200, overlap = 150): string[] {
  const chunks: string[] = [];
  const normalized = String(text || "").trim();
  if (!normalized) return chunks;

  let offset = 0;
  while (offset < normalized.length) {
    const chunk = normalized.slice(offset, offset + chunkSize).trim();
    if (chunk) chunks.push(chunk);
    if (offset + chunkSize >= normalized.length) break;
    offset += chunkSize - overlap;
  }
  return chunks;
}
