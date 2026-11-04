# Concord Hub em um container só (app + cliente compilado). Construa no seu PC e envie pronto ao servidor:
#   docker build -t concord:latest .
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY server server
COPY client client
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATABASE_PATH=/data/concord.db AUDIO_DIR=/data/audio IMAGES_DIR=/data/images BACKUP_DIR=/data/backups SERVER_PORT=3001
VOLUME /data
EXPOSE 3001
# O teto da memória do Node (heap) evita que ele cresça além do combinado numa máquina pequena
CMD ["node", "--max-old-space-size=110", "server/dist/index.js"]
