# Frontend image — build the Vite app, serve with nginx, proxy /api to the
# backend service (same-origin, no CORS config needed inside compose).

FROM node:20-alpine AS build
WORKDIR /app

# Layout mirrors the repo so "file:../shared" resolves exactly as locally:
#   /app/shared    (built: shared/dist)
#   /app/frontend  (deps + sources + vite build)
COPY shared/package.json shared/tsconfig.json shared/package-lock.json* ./shared/
COPY shared/types ./shared/types
WORKDIR /app/shared
RUN npm install && npm run build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

COPY frontend/tsconfig.json frontend/tsconfig.node.json frontend/vite.config.ts frontend/index.html frontend/postcss.config.js frontend/tailwind.config.js ./
COPY frontend/scripts scripts
COPY frontend/src src
RUN npm run build

# ---------- runtime ----------
FROM nginx:1.27-alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
