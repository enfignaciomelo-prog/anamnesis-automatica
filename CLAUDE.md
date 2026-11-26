# CLAUDE.md — Anamnesis Automática

Instrucciones permanentes para Claude Code en este repositorio.

## Requisito de trabajo: solo desde el teléfono

El responsable trabaja **exclusivamente desde un iPhone**, con Claude Code en la
nube (app Claude o claude.ai/code en Safari) y GitHub en Safari.

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

## Decisiones pendientes (no decidir sin consultar)

- **Transcripción de voz:** la API de Claude no convierte audio a texto. Elegir
  entre reconocimiento del navegador (Web Speech API; soporte y privacidad
  variables en Safari/iOS) o un servicio de transcripción dedicado.
- Plataforma de despliegue y almacenamiento (debe permitir vista previa por URL
  para revisar desde el teléfono).
- Sistema de autenticación.

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

0. Preparación del repositorio y skills (esta etapa).
1. Esqueleto PWA + modo demostración con transcripción ficticia.
2. Motor de extracción simulado: respaldo, «No referido», clasificaciones.
3. Editor del borrador, revisión y confirmación; exportación docx/pdf.
4. Plantillas propias (Word, Excel, PDF) con confirmación de campos.
5. Consentimiento, captura de audio y transcripción real.
6. Autenticación, separación por profesional y protección de datos.
7. Integración real con la API de Claude (solo servidor).

Cada etapa: rama propia, pruebas con `webapp-testing`, pull request en español
con instrucciones de verificación desde el teléfono.

## Convenciones

- Interfaz, textos y documentación en español (Chile).
- Commits pequeños; nunca trabajar directo en `main`.
