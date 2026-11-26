# Anamnesis Automática

PWA para profesionales de salud que escucha una entrevista clínica, la transcribe
en español y propone el llenado de una plantilla de anamnesis, con el fragmento
de la transcripción que respalda cada dato. El profesional revisa y confirma
todo antes de finalizar.

**Estado:** etapa 1, demostración funcional con datos ficticios. Qué es real,
qué es simulado y qué falta: [`docs/ESTADO.md`](docs/ESTADO.md).

## Cómo probarla

Desde el teléfono, una vez desplegada (ver `render.yaml`): abrir la URL en
Safari, entrar como «Profesional Demo A», crear una entrevista e iniciar la
escucha. La entrevista es ficticia y no se usa el micrófono.

## Estructura

| Carpeta | Contenido |
|---|---|
| `web/` | Interfaz React (Safari móvil primero) |
| `server/` | Servidor Node: API, eventos en vivo, extractor, exportación |
| `shared/` | Tipos y plantilla genérica compartidos |
| `public/` | Manifiesto PWA, íconos, service worker (sin caché clínica) |
| `tests/` | Pruebas unitarias, de integración y E2E |
| `.claude/skills/` | Skills oficiales usadas en el desarrollo |

## Comandos

`npm run build` compila la interfaz (Vite) y el servidor; `npm start` los sirve
juntos. `npm test` y `npm run test:e2e` ejecutan las pruebas.

Decisiones y reglas del proyecto: [`CLAUDE.md`](CLAUDE.md).

> Solo datos ficticios. No subir claves, archivos `.env`, grabaciones ni
> información de pacientes.
