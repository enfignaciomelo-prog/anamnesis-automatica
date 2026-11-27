# CLAUDE.md — Anamnesis Automática

Instrucciones permanentes para Claude Code en este repositorio.

## Requisito de trabajo: realizable desde el teléfono

El responsable trabaja desde un iPhone o un PC, con Claude Code en la nube
(app Claude o claude.ai/code) y GitHub en el navegador. **Todo el procedimiento
debe seguir siendo realizable solo desde Safari o la app móvil.**

- En una sesión de nube, `localhost` no es accesible desde el teléfono ni el PC:
  para probar, usar la versión desplegada por HTTPS.

- Nunca indicar pasos que requieran computador, terminal local, PowerShell,
  instalar programas en el teléfono o editar archivos a mano fuera de GitHub web.
- Todo comando se ejecuta en el entorno de nube de Claude Code. Si falta una
  dependencia, instalarla ahí; si la red lo impide, decirlo y proponer una
  alternativa que no requiera computador.
- Las revisiones se hacen en la pull request de GitHub (Safari) o en una vista
  previa desplegada accesible por URL.
- Al terminar cada tarea, explicar en español cómo verificar el resultado desde
  el teléfono.

## Producto

PWA para profesionales de salud (computador y teléfono, instalable) que escucha
una entrevista clínica, la transcribe en español y completa progresivamente un
borrador de anamnesis según la plantilla seleccionada.

## Reglas clínicas (no negociables)

1. **Respaldo obligatorio:** cada dato propuesto guarda el fragmento literal de la
   transcripción que lo respalda (texto + marca de tiempo). Sin respaldo, no se
   propone.
2. **«No referido»:** todo campo no mencionado queda exactamente como `No referido`.
3. **Clasificación de cada dato:** `actual`, `histórico`, `negado`
   (p. ej. «niega dolor torácico»), `familiar` (antecedente de un familiar,
   nunca atribuido al paciente) y `contradictorio` (se muestran ambas versiones
   con sus respaldos; no se elige una automáticamente).
4. El profesional puede editar cualquier campo; las ediciones manuales se marcan
   como tales.
5. **Revisión humana obligatoria:** no se finaliza ni exporta sin confirmación
   explícita del profesional.
6. La IA nunca diagnostica ni agrega información que no esté en la transcripción.

## Plantillas

- Plantillas predeterminadas incluidas en la app.
- Plantillas propias en Word, Excel o PDF: la app propone los campos detectados y
  el profesional confirma o corrige la correspondencia antes de usarlas.
- Leer `.claude/skills/docx`, `xlsx` o `pdf` antes de tocar esos formatos.

## Privacidad y seguridad

- Consentimiento explícito del paciente antes de escuchar; registrar fecha, hora
  y profesional. Controles visibles de iniciar, pausar y detener; indicador
  permanente mientras se escucha.
- Acceso individual por profesional; datos separados entre profesionales
  (aislamiento por usuario en servidor, no solo en la interfaz).
- Cifrado en tránsito y en reposo; mínima retención del audio (por defecto, no
  conservarlo tras transcribir).
- Marco de referencia en Chile: Ley 20.584 (derechos del paciente y ficha
  clínica), Ley 19.628 y Ley 21.719 (protección de datos personales). Validar con
  el área legal del establecimiento antes de usar datos reales.
- **Prohibido en el repositorio:** claves API, archivos `.env`, credenciales,
  grabaciones y cualquier dato real de pacientes. Usar solo datos ficticios.
- La clave de la API de Claude vive solo en el servidor (variables de entorno del
  proveedor de despliegue), nunca en el navegador.

## Modo demostración

- Funciona sin claves API: transcripciones ficticias pregrabadas y un extractor
  simulado que devuelve resultados deterministas con respaldos.
- Es el modo por defecto hasta que el responsable apruebe la integración real.
- Los datos ficticios deben verse claramente ficticios (nombres y RUT inventados
  y marcados como «DEMO»).

## Decisiones técnicas tomadas

- **Pila:** React + TypeScript + Vite (interfaz), Node.js + TypeScript con
  `node:http` sin framework (servidor), PostgreSQL (etapa 5), API de Claude
  (etapa 4), Deepgram (etapa 3).
- **Un solo proceso:** el servidor sirve la API y `dist/` (interfaz compilada).
- **Tiempo real:** Server-Sent Events (servidor → interfaz, reconexión
  automática, estado completo al reconectar) + POST para comandos. El audio
  viaja por HTTP al servidor y del servidor a Deepgram por WebSocket. Ninguna
  clave llega al navegador.
- **Deepgram:** Nova-3 con `es-419` para streaming. Se habilita en modo cuentas
  con `TRANSCRIPTION_MODE=deepgram` y `DEEPGRAM_API_KEY`. El navegador usa PCM
  mono mediante AudioWorklet y el servidor transmite sin guardar grabaciones.
- **Persistencia detrás de la interfaz `Store`** (`server/store.ts`): hoy en
  memoria; PostgreSQL debe implementar la misma interfaz con el dueño en cada consulta.
- **Extractor intercambiable:** `server/extraction/demoExtractor.ts` (reglas,
  simulado) en la demostración. Con `CLAUDE_FILL=true` (solo modo cuentas), el
  llenado lo pide el profesional y lo hace Claude (`server/real/anthropicFill.ts`,
  SDK oficial, salida estructurada); `server/extraction/claudeFill.ts` valida en el
  servidor cada propuesta contra la transcripción y la plantilla de la entrevista
  y decide los motivos de revisión. `merge.ts` se mantiene. Resultados ligados a
  la entrevista, versión de transcripción y sesión; tardíos se descartan.
- **Despliegue de demostración:** Render (`render.yaml`), configurable desde
  Safari. Alternativa: `Dockerfile`.
- **Estado real/simulado/pendiente:** mantener `docs/ESTADO.md` al día en cada PR.
- **Plantillas:** cada campo puede tener un «tipo de dato» (`shared/concepts.ts`)
  que el extractor usa; los campos sin tipo se completan a mano. Versiones
  inmutables; la entrevista copia la versión usada. Exportación en formato
  original solo en destinos confirmados (marcador, línea o celda); en Excel se
  escribe texto y nunca se tocan fórmulas. Archivos de prueba en `tests/fixtures`.

## Entorno de nube de Claude Code

- Si el registro npm no está disponible, ejecutar `scripts/link-offline-deps.sh`
  y compilar con `npm run build:web:offline` (esbuild). La CI de GitHub usa
  `npm install` y Vite, y ejecuta la integración real con PostgreSQL
  (`TEST_DATABASE_URL`). Localmente sin `pg`: `npm run typecheck:offline`.
- Pruebas: `npm test` (node:test) y `npm run test:e2e` (skill webapp-testing).
  El comando del servidor usa `exec` para que no queden procesos ocupando el puerto.

- **Cuentas (decisión del responsable):** Better Auth (correo y contraseña,
  verificación obligatoria, restablecimiento); PostgreSQL en Supabase São Paulo
  (sa-east-1); correo con Resend y adaptador de pruebas solo fuera de producción.
  Nunca desactivar la verificación de correo en producción. Esta infraestructura
  de pruebas **no** autoriza datos reales del CESFAM.
- **Identidad:** siempre desde la sesión del servidor; nunca un id enviado por el navegador.
- **Corte diario:** 23:59:00 America/Santiago (`shared/cutoff.ts`), exigido en el
  servidor desde el inicio de la sesión; bloqueo por inactividad configurable.
- **Navegador:** datos clínicos solo en memoria; limpieza al cerrar o vencer,
  propagada entre pestañas, con descarte de respuestas tardías (`web/session.ts`).
  **Excepción explícita (modo sin conexión manual, `web/offline/`):** borradores
  cifrados con Web Crypto en IndexedDB (`aa-offline`), un espacio por profesional
  con frase propia (no es la contraseña ni se guarda), que sobreviven al cierre de
  sesión y se eliminan en el corte diario aunque no estén sincronizados. Desbloquear
  es local y no prolonga la sesión. Tras sincronizar se borra el contenido local.
  `Clear-Site-Data` usa solo `"cache"` para no borrar esos borradores.
- **Sincronización offline:** `POST /api/offline/sync`, idempotente por
  (profesional, clientId, revisión); conflicto (editada, finalizada o eliminada en
  el servidor) → 409 sin sobrescribir; la plantilla siempre la resuelve el servidor.
- **Modo cuentas:** código en `server/real/` (pg, better-auth); se carga solo con
  `DEMO_MODE=false`. Migraciones en `server/real/migrations` (esquema `anamnesis`, RLS).
- **Pruebas:** las E2E son emulación en Chromium con tamaño de iPhone; no
  presentarlas como pruebas en Safari real.
- **Historial:** la limpieza local nunca elimina datos del servidor. La
  eliminación automática del historial está desactivada por defecto y solo se
  activa con configuración y confirmación explícitas del profesional.
- **Canales en vivo:** ligados a su sesión; el servidor los cierra al corte, al
  revocarse la sesión o por inactividad, sin depender del navegador.
- **Escucha:** pertenece a la sesión que la inició o reanudó; solo esa sesión
  queda exenta del bloqueo por inactividad y solo su cierre, vencimiento o
  revocación pausa la escucha (no la de una sesión observadora).
- **TLS PostgreSQL:** en producción, verificado con `DATABASE_CA_CERT`; prohibido
  `rejectUnauthorized:false`, `DATABASE_SSL=disable` y `sslmode` sin verificación.

## Orden de trabajo vigente

1. Cuentas reales y persistencia. ✅ (falta conexión externa)
2. Vencimiento diario y limpieza local. ✅
3. Modo offline manual cifrado y sincronización. ✅ (voz/IA offline: ver `docs/VOZ_IA_OFFLINE.md`)
4. Micrófono y transcripción real. ✅ código (pendiente prueba con Deepgram y Safari reales).
5. Llenado con Claude. ✅ código (pendiente verificación con la API real; ver `docs/DESPLIEGUE.md`).
Voz e IA offline: capacidad posterior por evaluar.

## Decisiones pendientes (no decidir sin consultar)

- Región del servidor de aplicación (Render no tiene región en Sudamérica).
- Política institucional de conservación y eliminación del historial (hoy:
  conservación hasta que el profesional elimine o configure la eliminación).
- Conector Rayen: después de offline, micrófono y llenado con Claude (se puede
  investigar antes la opción oficial).

## Skills del proyecto (`.claude/skills/`)

Origen y commit en `.claude/skills/ORIGEN.md`. Leer el `SKILL.md` pertinente
**antes** de cada tarea:

| Tarea | Skill |
|---|---|
| Interfaz y diseño visual | `frontend-design` |
| Pruebas de la app (Playwright) | `webapp-testing` |
| Plantillas/exportación Word | `docx` |
| Plantillas Excel | `xlsx` |
| Plantillas/exportación PDF | `pdf` |
| Integración con la API de Claude | `claude-api` |

No agregar plugins ni skills de terceros sin justificar su utilidad en la PR.

## Desarrollo por etapas

0. Preparación del repositorio y skills. ✅
1. Demostración funcional. ✅ (ver `docs/ESTADO.md`)
2. Plantillas propias. ✅ (OCR depende de tesseract en el servidor)
3. Micrófono y transcripción real con Deepgram.
4. Llenado con Claude (salida estructurada con respaldo literal).
5. Cuentas, seguridad y persistencia en PostgreSQL.
6. Despliegue y pruebas (incluye prueba real en Safari de iPhone).

Cada etapa: rama propia, pruebas con `webapp-testing`, pull request en español
con instrucciones de verificación desde el teléfono.

## Convenciones

- Interfaz, textos y documentación en español (Chile).
- Commits pequeños; nunca trabajar directo en `main`.
