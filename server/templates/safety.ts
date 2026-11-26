/**
 * Validación de archivos subidos. Los archivos son contenido no confiable:
 * se leen como datos, nunca se ejecutan macros, fórmulas ni instrucciones.
 */
import JSZip from "jszip";
import type { SourceKind } from "../../shared/types";
import { HttpError } from "../http";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 1500;
const MAX_UNCOMPRESSED = 40 * 1024 * 1024;

export function detectKind(fileName: string, bytes: Buffer): SourceKind {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (["docm", "xlsm", "dotm", "xltm", "xlsb"].includes(ext))
    throw new HttpError(415, "macros", "Los archivos con macros no se aceptan. Guárdalo como .docx o .xlsx.");
  if (["doc", "xls"].includes(ext))
    throw new HttpError(
      415,
      "formato_antiguo",
      "Formato antiguo no soportado. Ábrelo en Word, Excel o Pages y expórtalo como .docx o .xlsx.",
    );
  const isZip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const isPdf = bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ext === "docx" && isZip) return "docx";
  if (ext === "xlsx" && isZip) return "xlsx";
  if (ext === "pdf" && isPdf) return "pdf";
  throw new HttpError(
    415,
    "tipo_no_soportado",
    "Solo se aceptan archivos .docx, .xlsx o .pdf, y su contenido debe corresponder a la extensión.",
  );
}

/** Abre un paquete de Office con límites y rechaza contenido con macros. */
export async function openOfficeZip(bytes: Buffer, kind: "docx" | "xlsx"): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch {
    throw new HttpError(422, "archivo_danado", "No se pudo leer el archivo. Puede estar dañado o protegido con contraseña.");
  }
  const names = Object.keys(zip.files);
  if (names.length > MAX_ENTRIES) throw new HttpError(422, "archivo_complejo", "El archivo tiene demasiadas partes.");
  let total = 0;
  for (const n of names) {
    if (n.includes("..") || n.startsWith("/")) throw new HttpError(422, "archivo_invalido", "El archivo tiene rutas no válidas.");
    const size = (zip.files[n] as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
  }
  if (total > MAX_UNCOMPRESSED)
    throw new HttpError(422, "archivo_grande", "El archivo descomprimido es demasiado grande.");
  const types = (await zip.file("[Content_Types].xml")?.async("string")) ?? "";
  if (names.some((n) => /vbaProject\.bin$/i.test(n)) || /macroEnabled/i.test(types))
    throw new HttpError(415, "macros", "El archivo contiene macros y no se acepta. Guárdalo sin macros.");
  const main = kind === "docx" ? "word/document.xml" : "xl/workbook.xml";
  if (!zip.file(main))
    throw new HttpError(422, "archivo_invalido", `El archivo no parece un ${kind === "docx" ? "documento Word" : "libro Excel"} válido.`);
  return zip;
}
