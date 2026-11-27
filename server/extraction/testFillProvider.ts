/**
 * Proveedor SIMULADO del llenado asistido, solo para pruebas E2E
 * (ALLOW_TEST_FILL=true, nunca en producción). No llama a ningún servicio:
 * arma respuestas fijas desde la transcripción ficticia de la demostración,
 * incluida una propuesta con cita inventada que el servidor debe descartar.
 */
import type { FillProvider, FillRequest } from "./fillProvider";

export class TestFillProvider implements FillProvider {
  readonly model = "simulado (pruebas)";
  constructor(private delayMs = 400) {}

  async fill(req: FillRequest, signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("cancelada"));
      });
    });
    const seg = (re: RegExp) => req.segments.find((s) => re.test(s.text));
    const out: unknown[] = [];
    const add = (campo: string, valor: string, clasificacion: string, re: RegExp, cita: string, clave: string | null = null, duda = false) => {
      const s = seg(re);
      if (s) out.push({ campo, valor, clasificacion, clave, duda, respaldos: [{ segmento: s.id, cita }] });
    };
    add("motivo", "Mucha sed y orina harto hace tres semanas", "actual", /mucha sed/, "ando con mucha sed y orino harto, hace como tres semanas");
    add("medicamentos", "Metformina de 850 dos veces al día", "actual", /Metformina de 850/, "Metformina de 850, dos veces al día", "metformina");
    add("medicamentos", "Metformina tres veces al día", "actual", /subió la metformina/, "el doctor le subió la metformina a tres veces al día", "metformina");
    add("familiares", "Mamá diabética", "familiar", /Mi mamá era diabética/, "Mi mamá era diabética");
    add("quirurgicos", "Colecistectomía", "historico", /operaron/, "me hicieron una colecistectomía"); // cita inventada: se descarta
    return { propuestas: out };
  }
}
