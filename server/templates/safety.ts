/**
 * Validación de archivos subidos. Los archivos son contenido no confiable:
 * se leen como datos, nunca se ejecutan macros, fórmulas ni instrucciones.
 */
import { crc32 } from "node:zlib";
import { fromBufferPromise, type Entry } from "yauzl";
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
  if (bytes.length > MAX_UPLOAD_BYTES)
    throw new HttpError(413, "archivo_grande", "El archivo supera el límite de 5 MB.");

  try {
    const source = await fromBufferPromise(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true });
    try {
      if (source.entryCount > MAX_ENTRIES)
        throw new HttpError(422, "archivo_complejo", "El archivo tiene demasiadas partes.");

      const entries: Entry[] = [];
      const names = new Set<string>();
      let declared = 0;
      for await (const entry of source.eachEntry()) {
        if (names.has(entry.fileName))
          throw new HttpError(422, "archivo_invalido", "El archivo contiene partes duplicadas.");
        names.add(entry.fileName);
        if (/vbaProject\.bin$/i.test(entry.fileName))
          throw new HttpError(415, "macros", "El archivo contiene macros y no se acepta. Guárdalo sin macros.");
        declared += entry.uncompressedSize;
        if (declared > MAX_UNCOMPRESSED)
          throw new HttpError(422, "archivo_grande", "El archivo descomprimido es demasiado grande.");
        if (!entry.fileName.endsWith("/")) entries.push(entry);
      }

      const main = kind === "docx" ? "word/document.xml" : "xl/workbook.xml";
      if (!names.has(main))
        throw new HttpError(422, "archivo_invalido", `El archivo no parece un ${kind === "docx" ? "documento Word" : "libro Excel"} válido.`);

      // Solo se entrega a los analizadores contenido ya verificado. Yauzl corta
      // el flujo si excede el tamaño declarado para la entrada.
      const zip = new JSZip();
      let expanded = 0;
      for (const entry of entries) {
        const stream = await source.openReadStreamPromise(entry);
        const chunks: Buffer[] = [];
        let checksum = 0;
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          expanded += chunk.length;
          if (expanded > MAX_UNCOMPRESSED)
            throw new HttpError(422, "archivo_grande", "El archivo descomprimido es demasiado grande.");
          checksum = crc32(chunk, checksum);
          chunks.push(chunk);
        }
        if (checksum !== entry.crc32) throw new Error("CRC inválido");
        zip.file(entry.fileName, Buffer.concat(chunks), { createFolders: false, date: entry.getLastModDate() });
      }
      const types = (await zip.file("[Content_Types].xml")?.async("string")) ?? "";
      if (/macroEnabled/i.test(types))
        throw new HttpError(415, "macros", "El archivo contiene macros y no se acepta. Guárdalo sin macros.");
      return zip;
    } finally {
      source.close();
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(422, "archivo_danado", "No se pudo leer el archivo. Puede estar dañado o protegido con contraseña.");
  }
}
