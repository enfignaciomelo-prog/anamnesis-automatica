# Origen de las skills incluidas

| Campo | Valor |
|---|---|
| Repositorio | https://github.com/anthropics/skills |
| Rama | `main` (clon superficial `--depth 1`) |
| Commit | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` |
| Fecha del commit | 2026-11-16T09:22:47-05:00 |
| Mensaje | Update docx, pptx and xlsx skills: zipfile unpack, zip -y, validate.py and soffice.py fixes (#2221) |
| Descargado | 2026-11-26 |

Las carpetas se copiaron completas, sin modificaciones, desde `skills/<nombre>/`
del commit indicado (archivos verificados por conteo y `diff`). Cada una conserva
su `LICENSE.txt` (Apache License 2.0). `THIRD_PARTY_NOTICES.md` es el aviso de
terceros de la raíz del repositorio de origen, copiado íntegro.

## Skills y motivo de inclusión

| Skill | Archivos | Uso en Anamnesis Automática |
|---|---|---|
| `frontend-design` | 2 | Diseño de la interfaz PWA (móvil y escritorio). |
| `webapp-testing` | 6 | Pruebas de extremo a extremo con Playwright (Chromium y WebKit). |
| `docx` | 61 | Leer plantillas Word adjuntas y exportar la anamnesis a .docx. |
| `xlsx` | 53 | Leer plantillas Excel adjuntas y proponer sus campos. |
| `pdf` | 12 | Leer plantillas PDF (incluye formularios) y exportar a PDF. |
| `claude-api` | 96 | Integración con la API de Claude (extracción estructurada con respaldo en la transcripción). |

No se agregaron otros plugins ni skills de terceros.

## Actualizar

Pedir a Claude Code: «Actualiza las skills de `.claude/skills/` desde
anthropics/skills, muestra el diff y registra el nuevo commit en ORIGEN.md».
