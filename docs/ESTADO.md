# Estado de Anamnesis Automática

Última actualización: etapa 2 (plantillas propias), 26-11-2026.

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

## Cuentas, seguridad y privacidad

| Función | Estado | Detalle |
|---|---|---|
| Cuentas individuales | 🧪 | Dos perfiles ficticios sin contraseña. Cuentas reales: etapa 5. |
| Separación de datos entre profesionales | ✅ | Verificada en el servidor en cada ruta (probado: 404 para recursos ajenos). |
| Persistencia | 🧪 | En memoria: se pierde al reiniciar el servidor. PostgreSQL: etapa 5. |
| Retención configurable y eliminación | ✅ | 15 min, 1 h, 4 h o 12 h; botón para eliminar. |
| Audio no guardado | ✅ | No existe audio en esta etapa; el diseño no lo almacena. |
| Sin contenido clínico en registros | ✅ | Solo método, ruta normalizada, estado y duración (probado). |
| Sin datos clínicos en el navegador | ✅ | Sin localStorage, sessionStorage ni IndexedDB (probado). |
| Service worker sin caché clínica | ✅ | Ignora `/api/` (probado). |
| Cabeceras de seguridad, cookie HttpOnly/SameSite, verificación de origen | ✅ | |
| Explicación de datos por proveedor | ✅ | Pantalla «Qué datos se usan y dónde». |
| No ejecutar macros ni instrucciones de archivos | ✅ | Ver «Seguridad de archivos». |
| Claves solo en servidor | ✅ | Se leen de variables de entorno; hoy no se usan. |

## Plataforma

| Función | Estado | Detalle |
|---|---|---|
| PWA instalable (manifiesto, íconos, service worker) | ✅ | Probar «Agregar a inicio» en Safari tras el despliegue. |
| Diseño móvil primero y computador | ✅ | Probado en 390×844 y 1280×900 (Chromium). |
| Backend sirve la interfaz compilada | ✅ | Un solo proceso Node. |
| Compilación con Vite | ✅ | Verificada en la CI de GitHub. En el entorno de Claude Code sin registro npm se usa esbuild. |
| Verificación de tipos (interfaz y servidor) | ✅ | `tsc` en la CI de GitHub. |
| Despliegue HTTPS de demostración | ⏳ | `render.yaml` y `Dockerfile` preparados, sin probar. |
| Prueba en Safari/WebKit real | ⏳ | WebKit no está instalado aquí; pendiente en tu iPhone tras el despliegue. |

## Pruebas

- `npm test`: 36 pruebas unitarias y de integración (extractor, API, autorización,
  exportación, retención, registros, service worker, importación, versionado,
  exportación en formato original, macros, OCR).
- `npm run test:e2e`: flujo de demostración y flujo de plantillas con Playwright en
  tamaño iPhone y computador.
- Archivos de prueba ficticios en `tests/fixtures` (`npm run fixtures` los regenera).
- La CI de GitHub ejecuta tipos, pruebas, compilación con Vite y E2E en cada push y PR.
