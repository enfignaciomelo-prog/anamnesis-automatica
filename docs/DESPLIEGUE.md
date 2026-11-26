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
   Su contenido (texto PEM) es `DATABASE_CA_CERT`. Sin él, el canal va cifrado
   pero el servidor no verifica la identidad de la base.
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
| `DATABASE_CA_CERT` | cuentas | Certificado PEM de Supabase (recomendado) |
| `BETTER_AUTH_SECRET` | cuentas | Generado por Render (≥ 32 caracteres) |
| `BETTER_AUTH_URL` | cuentas | URL pública https del servicio |
| `RESEND_API_KEY` | cuentas | Clave de Resend |
| `EMAIL_FROM` | cuentas | Remitente permitido por Resend |
| `DEEPGRAM_API_KEY` | etapa 4 del nuevo orden | Aún no se usa |
| `ANTHROPIC_API_KEY` | etapa 5 del nuevo orden | Aún no se usa |

Variables solo para pruebas (nunca en Render): `EMAIL_TRANSPORT=prueba`,
`ALLOW_TEST_CLOCK=true`, `LOG_ERROR_DETAIL=1`, `TEST_DATABASE_URL`.

## Comprobaciones externas pendientes

- [ ] Despliegue en Render arranca y `/api/health` responde `{"auth":"cuentas","store":"postgres"}`.
- [ ] Conexión a Supabase São Paulo por *Session pooler* con `DATABASE_CA_CERT` verificado.
- [ ] Correo de verificación y de restablecimiento llegan vía Resend (dominio o correo propio).
- [ ] Prueba manual en **Safari real de iPhone** y en navegador de PC (las pruebas
      automáticas son emulación en Chromium).
- [ ] Región del servidor: Render no tiene región en Sudamérica (los datos se procesarían en EE. UU. aunque la base esté en São Paulo).
- [ ] Revisión de privacidad y legal del CESFAM antes de cualquier dato real.
