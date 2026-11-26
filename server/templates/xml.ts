/** Utilidades mínimas para XML de Office. Nunca se resuelven entidades externas. */

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
}

export function escapeXml(s: string): string {
  return stripControl(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Elimina caracteres de control no válidos en XML 1.0. */
export function stripControl(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");
}

export function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name.replace(":", "\\:")}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : undefined;
}

/** Normaliza una etiqueta leída de un archivo: es solo texto, nunca instrucciones. */
export function cleanLabel(s: string): string {
  return stripControl(s)
    .replace(/[_.…]{2,}/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*[:：]\s*$/, "")
    .trim()
    .slice(0, 120);
}

/** Heurística de «etiqueta de campo»: texto breve que termina en dos puntos o en línea para completar. */
export function looksLikeLabel(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 90) return false;
  if (!/[a-záéíóúñ]/i.test(t)) return false;
  return /[:：]\s*[_.…\s]*$/.test(t) || /_{3,}|\.{4,}|…{2,}/.test(t);
}
