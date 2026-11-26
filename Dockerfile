# Imagen alternativa para cualquier proveedor con contenedores. NO PROBADA todavía.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim
# OCR en español para PDF escaneados (opcional: sin esto se piden los campos a mano).
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-spa poppler-utils \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production DEMO_MODE=true TRUST_PROXY=true STATIC_DIR=dist PORT=3000
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/build ./build
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "build/server.js"]
