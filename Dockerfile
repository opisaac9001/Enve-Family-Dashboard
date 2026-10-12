FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils tesseract-ocr webp && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js feeds.js icloud.js imports.js ocr-linux.js recipes.js recurrence.js meal-ideas.js cloud-meal-ideas.js ./
COPY public ./public

ENV HOST=0.0.0.0 PORT=4317 DATABASE_PATH=/data/family.sqlite
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4317
VOLUME /data
CMD ["node", "server.js"]
