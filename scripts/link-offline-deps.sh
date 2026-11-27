#!/usr/bin/env bash
# Solo para el entorno de nube sin acceso al registro npm: enlaza paquetes ya
# instalados en /opt/npm-tools. En despliegue y CI se usa `npm install`.
set -euo pipefail
SRC=/opt/npm-tools/node_modules
mkdir -p node_modules/@types
for p in react react-dom typescript tsx esbuild docx pdf-lib pdfjs-dist zod jszip playwright ws @types/node @types/ws; do
  [ -e "$SRC/$p" ] && ln -sfn "$SRC/$p" "node_modules/$p"
done
echo "Dependencias enlazadas desde $SRC"
