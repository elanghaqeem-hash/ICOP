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
# Migrations MUST run as a deliberate, approved one-shot task, after a tested DB backup.
# Startup only validates the expected schema; it never mutates it or seeds users.
CMD ["node", "dist/server.js"]
