FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# OCR (Indonesia + Inggris), kompresi PDF & rasterisasi untuk Document Center
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-ind tesseract-ocr-data-eng ghostscript qpdf poppler-utils
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir -p /app/storage && chown node:node /app/storage
VOLUME ["/app/storage"]
USER node
EXPOSE 3001
# Migrasi berjalan idempoten saat start; seed hanya bila RUN_SEED=true
CMD ["sh", "-c", "node dist/migrate.js $( [ \"$RUN_SEED\" = true ] && echo --seed ) && node dist/server.js"]
