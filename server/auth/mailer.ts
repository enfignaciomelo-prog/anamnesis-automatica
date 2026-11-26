/**
 * Envío de correos de cuenta (verificación y restablecimiento).
 * - Resend: API REST oficial (https://resend.com/docs/api-reference/emails/send-email).
 * - Prueba: bandeja en memoria, solo fuera de producción. Nunca se registra el
 *   contenido de los correos ni sus enlaces en los registros.
 */
import { logEvent } from "../log";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: "verificacion" | "restablecer";
}

export interface Mailer {
  readonly kind: "resend" | "prueba";
  send(mail: Mail): Promise<void>;
}

export class ResendMailer implements Mailer {
  readonly kind = "resend" as const;
  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async send(mail: Mail) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
    });
    if (!res.ok) {
      logEvent("mail_error", { kind: mail.kind, status: res.status });
      throw new Error(`resend_${res.status}`);
    }
    logEvent("mail_sent", { kind: mail.kind });
  }
}

/** Adaptador de pruebas: guarda los correos en memoria (máx. 50). */
export class TestMailer implements Mailer {
  readonly kind = "prueba" as const;
  readonly outbox: (Mail & { at: string })[] = [];

  async send(mail: Mail) {
    this.outbox.unshift({ ...mail, at: new Date().toISOString() });
    this.outbox.length = Math.min(this.outbox.length, 50);
    logEvent("mail_test_outbox", { kind: mail.kind });
  }
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function verificationMail(to: string, url: string): Mail {
  return {
    kind: "verificacion",
    to,
    subject: "Verifica tu correo en Anamnesis Automática",
    text: `Para activar tu cuenta abre este enlace:\n${url}\n\nSi no creaste una cuenta, ignora este mensaje.`,
    html: `<p>Para activar tu cuenta en Anamnesis Automática, abre este enlace:</p><p><a href="${esc(url)}">Verificar mi correo</a></p><p>Si no creaste una cuenta, ignora este mensaje.</p>`,
  };
}

export function resetMail(to: string, url: string): Mail {
  return {
    kind: "restablecer",
    to,
    subject: "Restablece tu contraseña de Anamnesis Automática",
    text: `Para elegir una contraseña nueva abre este enlace:\n${url}\n\nEl enlace vence pronto. Si no lo pediste, ignora este mensaje.`,
    html: `<p>Para elegir una contraseña nueva, abre este enlace:</p><p><a href="${esc(url)}">Restablecer contraseña</a></p><p>El enlace vence pronto. Si no lo pediste, ignora este mensaje.</p>`,
  };
}
