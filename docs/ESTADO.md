# Estado de Anamnesis Automática

Última actualización: cuentas, persistencia y corte diario, 26-11-2026.

Orden vigente (decisión del responsable): 1) cuentas y persistencia ✅, 2) vencimiento diario y limpieza local ✅, 3) modo offline cifrado y sincronización ⏳, 4) micrófono y transcripción ⏳, 5) llenado con Claude ⏳. Voz e IA offline: capacidad posterior por evaluar.

**Leyenda:** ✅ Real (funciona de verdad) · 🧪 Simulado (funciona con datos o
lógica de demostración) · ⏳ Pendiente (no existe aún)

## Entrevista

| Función | Estado | Detalle |
|---|---|---|
| Consentimiento antes de escuchar | ✅ | El servidor rechaza iniciar sin consentimiento registrado (quién y cuándo). |
| Iniciar, pausar, reanudar, detener | ✅ | Controles reales; la fuente de audio es simulada. |
| Indicadores de escucha y conexión | ✅ | Escuchando/Pausada/Detenida; Conectado/Reconectando/Sin conexión. |
| Micrófono | ⏳ | Etapa 3. Hoy no se activa. |
| Transcripción | 🧪 | Guion ficticio emitido palabra por palabra por el servidor. Deepgram: etapa 3. |
| Texto provisional separado del definitivo | ✅ | Eventos `interim` y segmentos definitivos distintos en la interfaz. |
| Asignación de hablantes por el profesional | ✅ | La app no asume quién es el paciente; sin asignar, todo queda en revisión. |
| Propuestas con fragmento de respaldo | 🧪 | Extractor de reglas (no IA). Respaldo literal real; tocarlo lleva al segmento. |
| Clasificación actual / histórico / negado / familiar | 🧪 | Reglas sobre el texto. Claude: etapa 4. Funciona también en plantillas propias a través del tipo de dato de cada campo. |
| No convertir lo no mencionado en negación | ✅ | Solo negaciones explícitas; probado. |
| Contradicciones y autocorrecciones | 🧪 | Reglas (dosis, frecuencia, afirmación/negación, «perdón, mejor dicho»). |
| Revisión obligatoria de medicamentos, dosis y alergias | ✅ | Siempre «Requiere revisión». |
| Estados No referido / Propuesto / Requiere revisión / Confirmado | ✅ | |
| No sobrescribir cambios del profesional | ✅ | Información nueva se muestra aparte y vuelve el campo a revisión. |
| Revisión antes de finalizar | ✅ | Exige detener, resolver lo pendiente y declarar la revisión. |
| Exportar texto, Word, PDF | ✅ | Solo después de finalizar; respaldo opcional. |
| Exportar Excel | ✅ | Para plantillas importadas desde Excel (etapa 2). |
| Pausa al pasar a segundo plano (llamada, bloqueo) | ✅ | Se pausa y se explica; no hay escucha en segundo plano. |
| Pausa por pérdida de conexión | ✅ | El servidor pausa si la interfaz se desconecta (8 s). Reconexión automática. |

## Plantillas (etapa 2)

| Función | Estado | Detalle |
|---|---|---|
| Plantilla genérica predeterminada | ✅ | Solo lectura; se puede duplicar. |
| Crear y editar secciones y campos | ✅ | Nombre, tipo de dato, revisión obligatoria, orden, agregar y quitar. |
| Tipo de dato por campo | ✅ | Indica qué reconoce el extractor. Medicamentos y alergias siempre con revisión obligatoria. |
| Versionado | ✅ | Cada guardado crea una versión; se pueden ver las anteriores; las entrevistas conservan la suya; se rechaza guardar sobre una versión desactualizada. |
| Importar DOCX con vista previa y confirmación | ✅ | Marcadores de Word, líneas «Etiqueta:» o con «____», secciones por títulos. |
| Importar XLSX con hoja y celda | ✅ | Etiquetas y nombres definidos; hoja y celda editables; celdas con fórmula no se pueden mapear. |
| Importar PDF con texto | ✅ | Solo propone campos; la exportación usa el formato estándar. |
| PDF escaneado: OCR y revisión manual | ✅ / ⚠️ | OCR en español con tesseract si el servidor lo tiene (incluido en el `Dockerfile`); los campos quedan marcados «Leído por OCR: revisar». Sin OCR (p. ej., Render con runtime Node), se piden los campos a mano. |
| Exportar en el formato de la plantilla (Word) | ✅ | Llena una copia en marcadores o al final de la línea de la etiqueta. Marca «DATOS FICTICIOS» en modo demo. |
| Exportar Excel de plantillas mapeadas | ✅ | Escribe solo en las celdas confirmadas, como texto; no toca fórmulas. |
| Conservación exacta del diseño | ❌ No se promete | Se avisa al importar y al exportar. |
| Seguridad de archivos | ✅ | Máx. 5 MB; rechaza macros (.docm, .xlsm o `vbaProject.bin` aunque se renombre), formatos antiguos y extensiones que no coinciden; límites de descompresión; nunca se ejecutan macros, fórmulas ni scripts; el texto de los archivos se trata solo como datos. |
| Separación entre profesionales | ✅ | Plantillas y archivos originales accesibles solo por su dueño (probado). |
| Persistencia de plantillas | 🧪 | En memoria, como el resto de la demo (PostgreSQL: etapa 5). |

## Cuentas, persistencia y sesión

| Función | Estado | Detalle |
|---|---|---|
| Correo y contraseña con Better Auth | ✅ código / ⚠️ externo | Biblioteca mantenida (sin criptografía propia). Probado en CI con PostgreSQL 16 real; falta probar con Supabase y Resend reales. |
| Verificación de correo obligatoria | ✅ | Sin verificar no se puede entrar (probado). En producción el correo de prueba está prohibido. |
| Recuperación de contraseña | ✅ | Enlace por correo; revoca las sesiones anteriores (probado). |
| Adaptador de correo de pruebas | ✅ | Bandeja en memoria, solo fuera de producción. |
| Persistencia en PostgreSQL | ✅ código / ⚠️ externo | Anamnesis, plantillas, archivos originales y ajustes por propietario. Sobreviven a un reinicio y permiten exportar después (probado en CI). Supabase São Paulo pendiente de conectar. |
| Esquema propio y RLS | ✅ | Esquema `anamnesis` (no expuesto por la API de Supabase), RLS activado en todas las tablas. |
| Separación entre profesionales | ✅ | Identidad tomada de la sesión del servidor; lectura, edición, eliminación, eventos, archivos y exportaciones verificadas (404 para recursos ajenos, probado en memoria y PostgreSQL). |
| Mis anamnesis: búsqueda por fecha y estado | ✅ | Borrador / Revisada; fechas en hora de Chile; última modificación visible. |
| Autoguardado con confirmación del servidor | ✅ | «Guardando», «Guardado» (solo con respuesta del servidor) y «Error al guardar»; el texto en edición se guarda como borrador sin confirmarlo. |
| Corte diario 23:59 America/Santiago | ✅ | Calculado con zona horaria (probado en 2025–2027 con cambios de horario). Exigido en el servidor; sin bucle al volver a entrar. |
| Vencimiento con la app activa | ✅ | Detiene escucha y canales, limpia y exige nuevo inicio de sesión (E2E con reloj de prueba). |
| App suspendida o cerrada | ✅ / límite | Al reanudar o reabrir se revalida antes de mostrar datos. **No se puede borrar con la app cerrada**; el navegador no garantiza borrado físico puntual. |
| Aviso 5 minutos antes del corte | ✅ | Intenta guardar los borradores e informa si falla; no retrasa el cierre. |
| Bloqueo por inactividad configurable | ✅ | 5, 15, 30 o 60 minutos; exigido en servidor; no bloquea mientras se escucha. |
| Cierre manual y entre pestañas | ✅ | Propagado a otras pestañas; cancela peticiones; una respuesta tardía no repuebla datos; «Atrás» no muestra contenido clínico (E2E). |
| Cookies | ✅ | HttpOnly, SameSite, Secure con HTTPS; verificación de origen en cambios. |
| Sin datos clínicos en el navegador | ✅ | Sin localStorage, sessionStorage ni IndexedDB; caché solo pública; limpieza de versiones anteriores; `Clear-Site-Data` al cerrar. |
| Retención y eliminación configurables | ✅ | Modo cuentas: 7, 30, 90 o 365 días sin actividad; botón para eliminar. |
| Audio no guardado | ✅ | No existe audio todavía; el diseño no lo almacena. |
| Sin contenido clínico en registros | ✅ | Probado. |
| Explicación de datos por proveedor | ✅ | Incluye Supabase y Resend. |
| No ejecutar macros ni instrucciones de archivos | ✅ | Ver plantillas. |
| Claves solo en servidor | ✅ | Variables de entorno; ver `docs/DESPLIEGUE.md`. |

## Plataforma

| Función | Estado | Detalle |
|---|---|---|
| PWA instalable (manifiesto, íconos, service worker) | ✅ | Probar «Agregar a inicio» en Safari tras el despliegue. |
| Diseño móvil primero y computador | ✅ | Probado en 390×844 y 1280×900 (Chromium). |
| Backend sirve la interfaz compilada | ✅ | Un solo proceso Node. |
| Compilación con Vite | ✅ | Verificada en la CI de GitHub. En el entorno de Claude Code sin registro npm se usa esbuild. |
| Verificación de tipos (interfaz y servidor) | ✅ | `tsc` en la CI de GitHub. |
| Despliegue HTTPS | ⏳ | `render.yaml` preparado (demo por defecto; cuentas con secretos en el panel). Sin probar. Render no tiene región en Sudamérica: el servidor procesaría datos en EE. UU.; revisar con el CESFAM. |
| Prueba en Safari real de iPhone | ⏳ | Las pruebas automáticas son **emulación en Chromium** con tamaño de iPhone, no Safari real. |

## Pruebas

- CI de GitHub: 62 pruebas, incluidas 6 de integración real con PostgreSQL 16 + Better Auth + correo de prueba.
- `npm test`: pruebas unitarias y de integración (extractor y casos clínicos pedidos, API, autorización,
  exportación, retención, registros, service worker, importación, versionado,
  exportación en formato original, macros, OCR).
- `npm run test:e2e`: flujos de demostración, plantillas y sesión con Playwright.
  **Emulación en Chromium** con tamaño de iPhone y computador; no son pruebas en Safari real.
- Archivos de prueba ficticios en `tests/fixtures` (`npm run fixtures` los regenera).
- La CI de GitHub ejecuta tipos, pruebas, compilación con Vite y E2E en cada push y PR.
