# Estado de Anamnesis Automática

Última actualización: etapa 1 (demostración funcional), 26-11-2026.

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
| Clasificación actual / histórico / negado / familiar | 🧪 | Reglas sobre el texto. Claude: etapa 4. |
| No convertir lo no mencionado en negación | ✅ | Solo negaciones explícitas; probado. |
| Contradicciones y autocorrecciones | 🧪 | Reglas (dosis, frecuencia, afirmación/negación, «perdón, mejor dicho»). |
| Revisión obligatoria de medicamentos, dosis y alergias | ✅ | Siempre «Requiere revisión». |
| Estados No referido / Propuesto / Requiere revisión / Confirmado | ✅ | |
| No sobrescribir cambios del profesional | ✅ | Información nueva se muestra aparte y vuelve el campo a revisión. |
| Revisión antes de finalizar | ✅ | Exige detener, resolver lo pendiente y declarar la revisión. |
| Exportar texto, Word, PDF | ✅ | Solo después de finalizar; respaldo opcional. |
| Exportar Excel | ⏳ | Etapa 2 (plantillas mapeadas a hoja y celda). |
| Pausa al pasar a segundo plano (llamada, bloqueo) | ✅ | Se pausa y se explica; no hay escucha en segundo plano. |
| Pausa por pérdida de conexión | ✅ | El servidor pausa si la interfaz se desconecta (8 s). Reconexión automática. |

## Plantillas

| Función | Estado |
|---|---|
| Plantilla genérica predeterminada | ✅ |
| Crear y editar secciones y campos | ⏳ Etapa 2 |
| Versionado de plantillas | ⏳ Etapa 2 (hoy la genérica es v1 y se copia en cada entrevista) |
| Importar DOCX y XLSX con vista previa y confirmación | ⏳ Etapa 2 |
| Mapeo de hoja y celda en Excel; marcadores en Word | ⏳ Etapa 2 |
| Importar PDF con texto | ⏳ Etapa 2 |
| OCR para escaneos con revisión manual | ⏳ Etapa 2 |

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
| No ejecutar macros ni instrucciones de archivos | ⏳ | Aplica a la importación (etapa 2). |
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

## Pruebas (etapa 1)

- `npm test`: 22 pruebas unitarias y de integración (extractor, API, autorización,
  exportación, retención, registros, service worker).
- `npm run test:e2e`: flujo completo con Playwright en tamaño iPhone y computador.
- La CI de GitHub ejecuta tipos, pruebas, compilación con Vite y E2E en cada push y PR.
