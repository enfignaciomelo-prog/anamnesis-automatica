/**
 * Proveedor real del llenado asistido: API de Claude con el SDK oficial
 * (@anthropic-ai/sdk). Solo se carga con CLAUDE_FILL=true en modo cuentas.
 *
 * - Clave solo en el servidor (ANTHROPIC_API_KEY); nunca se registra ni llega al navegador.
 * - Salida estructurada: output_config.format con type "json_schema" (GA, sin cabecera beta).
 * - Streaming + finalMessage() para entradas largas sin agotar el tiempo de la petición.
 * - Respaldo ante rechazos de seguridad con `fallbacks: "default"` (beta
 *   server-side-fallback-2026-07-01) en los modelos que lo admiten; se puede
 *   desactivar con CLAUDE_FALLBACKS=false.
 * - El resultado se valida después en el servidor (claudeFill.ts): aquí solo se
 *   interpreta el JSON y se traducen los errores a mensajes sin datos clínicos.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config";
import { buildUserMessage, OUTPUT_SCHEMA, SYSTEM_PROMPT } from "../extraction/claudeFill";
import { type FillProvider, FillProviderError, type FillRequest } from "../extraction/fillProvider";

const MANUAL = "Puedes completar los campos manualmente.";

export function createClaudeFill(cfg: NonNullable<Config["claude"]>, fallbacks = true): FillProvider {
  const client = new Anthropic({ apiKey: cfg.key, timeout: cfg.timeoutMs, maxRetries: 2 });
  const withFallback = fallbacks && /^claude-(opus-5|sonnet-5-5|fable-5-1)/.test(cfg.model);
  type StreamParams = Parameters<typeof client.beta.messages.stream>[0];

  return {
    model: cfg.model,
    async fill(req: FillRequest, signal: AbortSignal) {
      const params = {
        model: cfg.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(req.template, req.segments, req.roles) }],
        output_config: { effort: cfg.effort, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        ...(withFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      };
      let message;
      try {
        const stream = client.beta.messages.stream(params as unknown as StreamParams, { signal });
        message = await stream.finalMessage();
      } catch (e) {
        if (signal.aborted || e instanceof Anthropic.APIUserAbortError) throw e;
        throw translate(e);
      }
      if (message.stop_reason === "refusal")
        throw new FillProviderError(`Claude no completó esta solicitud. ${MANUAL}`, "rechazo");
      if (message.stop_reason === "max_tokens")
        throw new FillProviderError(`La respuesta de Claude quedó incompleta. ${MANUAL}`, "max_tokens");
      const text = message.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new FillProviderError(`Claude devolvió una respuesta inválida. No se aplicó nada. ${MANUAL}`, "json_invalido");
      }
    },
  };
}

function translate(e: unknown): FillProviderError {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return new FillProviderError(`El servidor no tiene una clave de Claude válida. ${MANUAL}`, "clave");
  if (e instanceof Anthropic.RateLimitError)
    return new FillProviderError(`Se alcanzó el límite de uso de Claude. Intenta más tarde. ${MANUAL}`, "limite");
  if (e instanceof Anthropic.APIConnectionTimeoutError)
    return new FillProviderError(`Claude tardó demasiado en responder. ${MANUAL}`, "tiempo");
  if (e instanceof Anthropic.APIConnectionError)
    return new FillProviderError(`No se pudo conectar con Claude. ${MANUAL}`, "conexion");
  if (e instanceof Anthropic.BadRequestError)
    return new FillProviderError(`Claude rechazó la solicitud por un problema de configuración. ${MANUAL}`, "solicitud");
  if (e instanceof Anthropic.APIError)
    return new FillProviderError(`Claude no está disponible en este momento. ${MANUAL}`, `api_${e.status ?? "x"}`);
  return new FillProviderError(`No se pudo obtener la respuesta de Claude. ${MANUAL}`, "desconocido");
}
