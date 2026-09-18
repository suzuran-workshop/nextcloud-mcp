import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import XLSX from "xlsx";

/**
 * Extract text content from a file buffer based on extension.
 * Supports: txt, md, csv, docx, xlsx, pdf
 */
export async function extractTextFromBuffer(
  buffer: Buffer,
  extension: string
): Promise<string> {
  const ext = String(extension || "").toLowerCase();

  if (["txt", "md", "csv"].includes(ext)) {
    return buffer.toString("utf8");
  }

  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  if (ext === "xlsx") {
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

  if (ext === "pdf") {
    const result = await pdfParse(buffer);
    return result.text || "";
  }

  return "";
}

/**
 * Check if the file extension is extractable as text.
 */
export function isExtractableFile(extension: string): boolean {
  return ["txt", "md", "csv", "docx", "xlsx", "pdf"].includes(
    String(extension || "").toLowerCase()
  );
}

/**
 * Normalize extracted text: collapse whitespace, trim.
 */
export function normalizeExtractedText(value: string): string {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}