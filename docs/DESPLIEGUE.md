# Despliegue de pruebas (HTTPS) y configuración externa

> **Solo datos ficticios.** Esta infraestructura de pruebas no autoriza el uso de
> datos reales del CESFAM. Ninguna clave se pega en el chat ni en el repositorio:
> se configuran en los paneles de cada proveedor.

## Modos

| Modo | Cuándo | Requiere |
|---|---|---|
| Demostración (`DEMO_MODE=true`, predeterminado) | Probar la app desde el iPhone sin cuentas | Nada más |
| Cuentas (`DEMO_MODE=false`) | Cuentas reales con correo y contraseña, datos en PostgreSQL | Supabase + Resend (abajo) |

En producción (`NODE_ENV=production`) el correo de prueba está **prohibido**: la
verificación de correo nunca se desactiva. Mientras no tengas Resend
configurado, usa el modo demostración.

## Pasos manuales (todos desde el navegador)

### 1. Supabase (PostgreSQL, São Paulo)
1. supabase.com → New project → **Region: South America (São Paulo) – sa-east-1**.
2. Project Settings → Database → **Connection string → Session pooler** (IPv4,
   puerto 5432). Esa cadena es `DATABASE_URL` (incluye la contraseña de la base).
3. Project Settings → Database → **SSL Configuration → Download certificate**.
   Su contenido (texto PEM) es `DATABASE_CA_CERT`. **Es obligatorio en
   producción**: el servidor no arranca sin él, ni con `DATABASE_SSL=disable`, ni
   con un `sslmode` que no verifique. No existe opción sin verificación.
4. Activa **Enforce SSL**.
5. La app crea sus tablas en el esquema `anamnesis` (no expuesto por la API de
   datos de Supabase) con RLS activado. No uses la `anon key` en ninguna parte.

### 2. Resend (correo)
1. resend.com → API Keys → crear una clave con permiso de envío: `RESEND_API_KEY`.
2. Mientras no verifiques un dominio, Resend solo envía desde
   `onboarding@resend.dev` y **solo a tu propio correo** de la cuenta Resend.
   Para pruebas: `EMAIL_FROM="Anamnesis <onboarding@resend.dev>"`.
3. Con dominio verificado: `EMAIL_FROM="Anamnesis <no-responder@tu-dominio>"`.

### 3. Render (servidor HTTPS)
1. dashboard.render.com → New → **Blueprint** → repositorio `anamnesis-automatica`.
2. Render pedirá los valores marcados como secretos en `render.yaml`. Déjalos
   vacíos si solo quieres la demostración.
3. `BETTER_AUTH_SECRET` lo genera Render automáticamente.
4. Cuando el servicio tenga URL (`https://<nombre>.onrender.com`), ponla en
   `BETTER_AUTH_URL`.
5. Para activar cuentas: cambia `DEMO_MODE` a `false` y guarda. El servidor
   aplica las migraciones al iniciar.

## Variables de entorno

| Variable | Modo | Descripción |
|---|---|---|
| `DEMO_MODE` | ambos | `true` (demo) o `false` (cuentas) |
| `NODE_ENV` | ambos | `production` en Render |
| `TRUST_PROXY` | ambos | `true` detrás del HTTPS de Render |
| `DATABASE_URL` | cuentas | Cadena del *Session pooler* de Supabase |
| `DATABASE_CA_CERT` | cuentas | Certificado PEM de Supabase (**obligatorio en producción**) |
| `BETTER_AUTH_SECRET` | cuentas | Generado por Render (≥ 32 caracteres) |
| `BETTER_AUTH_URL` | cuentas | URL pública https del servicio |
| `RESEND_API_KEY` | cuentas | Clave de Resend |
| `EMAIL_FROM` | cuentas | Remitente permitido por Resend |
| `TRANSCRIPTION_MODE` | ambos | `demo` por defecto. Para activar el micrófono con cuentas, usa `deepgram` |
| `DEEPGRAM_API_KEY` | cuentas con micrófono | Clave de Deepgram, solo en el panel del servidor |
| `CLAUDE_FILL` | cuentas | `false` por defecto. `true` activa el llenado asistido con Claude (rechazado en modo demostración) |
| `ANTHROPIC_API_KEY` | cuentas con Claude | Clave de la API de Claude, solo en el panel del servidor. Sola no activa nada |
| `CLAUDE_MODEL` | cuentas con Claude | Opcional. `claude-opus-5-5` por defecto |
| `CLAUDE_EFFORT` | cuentas con Claude | Opcional. `high` por defecto (`low`, `medium`, `high`, `xhigh`, `max`) |
| `CLAUDE_TIMEOUT_MS` | cuentas con Claude | Opcional. 180000 por defecto (entre 10000 y 600000) |
| `CLAUDE_FALLBACKS` | cuentas con Claude | Opcional. `false` desactiva el respaldo del servidor ante rechazos de seguridad |

Variables solo para pruebas (nunca en Render): `EMAIL_TRANSPORT=prueba`,
`ALLOW_TEST_CLOCK=true`, `ALLOW_TEST_FILL=true` (llenado simulado, ignorado en producción), `LOG_ERROR_DETAIL=1`, `TEST_DATABASE_URL`,
`DATABASE_SSL=disable` (rechazada en producción).

Opcional: `SESSION_CHECK_MS` (predeterminado 15000): cada cuánto el servidor
revisa las sesiones con canales en vivo abiertos.

## Probar micrófono y transcripción

En una instancia HTTPS de prueba con cuentas, agrega `DEEPGRAM_API_KEY` y
`TRANSCRIPTION_MODE=deepgram` en el panel **Environment** del servidor. Usa una
clave del proyecto de pruebas. El navegador envía PCM mono y el servidor lo
transmite por WebSocket a Nova-3 con `es-419`. La app conserva el texto y no
archiva audio. La solicitud usa `mip_opt_out=true`. Revisa las condiciones de
tratamiento y retención del proyecto de Deepgram por separado.

1. En PC, abre una entrevista, registra consentimiento y acepta el permiso del
   micrófono. Repite denegando el permiso y comprueba que puedes volver a intentar.
2. En Safari real de iPhone, repite desde Safari y desde la app agregada a Inicio.
   Cambia de app o bloquea la pantalla. Verifica la pausa y reanuda de forma
   explícita. Repite al perder y recuperar la red.
3. Para evaluar español de Chile, dos personas leen frases ficticias como «Me
   tinca que fue ayer», «Me duele la guata», «Partió al tiro» y «Tomo losartán
   cincuenta miligramos». Compara palabras, cifras y hablantes con el guion.
   Pausa y reanuda entre frases y pronuncia la última justo antes de detener.
   Registra omisiones, duplicados y cambios de significado. La prueba con un
   proveedor local comprueba el flujo y el formato; la precisión del servicio
   se mide con esta prueba externa.

[Modelos e idiomas de Deepgram](https://developers.deepgram.com/docs/models-languages-overview) ·
[Referencia de streaming](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)

## Probar el llenado con Claude

Requiere modo cuentas. No necesita Deepgram: con `TRANSCRIPTION_MODE=demo` la
entrevista usa la transcripción ficticia de la demostración.

1. En el panel **Environment** del servidor agrega `ANTHROPIC_API_KEY` (clave de
   un proyecto de pruebas) y `CLAUDE_FILL=true`. Nunca pegues la clave en el chat
   ni en el repositorio. Guarda y espera el nuevo despliegue.
2. Inicia sesión, crea una entrevista, registra el consentimiento y deja correr
   la entrevista ficticia hasta «Detenida». Asigna los hablantes.
3. En la pestaña **Anamnesis**, toca **Completar con Claude**. Mientras responde
   puedes seguir editando; tus correcciones no se sobrescriben.
4. Revisa cada propuesta con su fragmento literal. Medicamentos, dosis, alergias
   y contradicciones quedan en «Requiere revisión». Finalizar exige resolverlos.
5. Si Claude falla o responde algo inválido, el panel lo informa y puedes
   completar todo manualmente.

Comportamiento del servidor:

- Envía a Claude solo los segmentos definitivos, el rol asignado a cada hablante
  y los campos de la versión de plantilla guardada en la entrevista. Nunca audio,
  nombre del profesional ni identificadores de cuenta.
- La transcripción va como datos dentro de etiquetas; el texto del paciente no
  puede cerrarlas ni dar instrucciones.
- Salida estructurada (`output_config.format`, `json_schema`) con modelo
  `claude-opus-5-5` y esfuerzo `high`. El SDK oficial está fijado en `0.137.0`.
- Cada propuesta se valida: campo de la plantilla, cita literal de un segmento
  existente, negación explícita, familiar mencionado y en el campo familiar, y
  números y palabras presentes en la cita. Lo demás se descarta y se cuenta.
- El resultado queda ligado a la entrevista, a la versión de la transcripción y
  a la sesión que lo pidió. Se descarta si la transcripción cambia, si la sesión
  se cierra, vence en el corte diario o se revoca, o si llega otra solicitud.
- Los registros solo guardan conteos y códigos, nunca texto clínico.

Pendiente de verificar con la API real (no se pudo desde el entorno de desarrollo,
sin acceso al registro npm ni a la API): instalación del SDK `0.137.0` (la CI lo
instala y compila), aceptación de `fallbacks: "default"` junto con la salida
estructurada (si la API lo rechaza, usar `CLAUDE_FALLBACKS=false`), tiempo de
respuesta y calidad de las propuestas en español de Chile. El SDK ya publicó la
versión 1.0.0 con cambios incompatibles; la actualización queda como tarea aparte.

[Salida estructurada](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

## Historial y limpieza

- La limpieza local del dispositivo (corte 23:59, cierre de sesión, inactividad)
  **no** elimina nada del servidor.
- La eliminación automática del historial en el servidor está **desactivada por
  defecto** y solo se activa desde Configuración, con confirmación explícita.

## Comprobaciones externas pendientes

- [ ] Despliegue en Render arranca y `/api/health` responde `{"auth":"cuentas","store":"postgres"}`.
- [ ] Conexión a Supabase São Paulo por *Session pooler* con `DATABASE_CA_CERT`
      verificado (el certificado debe validar el host del pooler; si falla, revisar
      con el soporte de Supabase en vez de desactivar la verificación).
- [ ] Correo de verificación y de restablecimiento llegan vía Resend (dominio o correo propio).
- [ ] Prueba manual en **Safari real de iPhone** y en navegador de PC (las pruebas
      automáticas son emulación en Chromium).
- [ ] Región del servidor: Render no tiene región en Sudamérica (los datos se procesarían en EE. UU. aunque la base esté en São Paulo).
- [ ] Revisión de privacidad y legal del CESFAM antes de cualquier dato real.
