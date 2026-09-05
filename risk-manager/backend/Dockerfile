# syntax=docker/dockerfile:1
# Backend image — multi-stage build.
# Layout mirrors the repo so "file:../shared" resolves exactly as locally:
#   /app/shared   (built: shared/dist)
#   /app/backend  (deps + src + built dist)
# evaluation/ is COPYed so the runtime serves /api/evaluation/fraud-spike and
# loads the fitted calibration at startup.

FROM node:20-alpine AS build
WORKDIR /app

# 1) Build shared first (backend's file: dependency target).
COPY shared/package.json shared/tsconfig.json shared/package-lock.json* ./shared/
COPY shared/types ./shared/types
WORKDIR /app/shared
RUN npm install && npm run build

# 2) Backend deps (file:../shared -> /app/shared with dist present) + compile.
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json* ./
RUN npm install

COPY backend/tsconfig.json ./
COPY backend/src src
RUN npm run build

# 3) Runtime data files the compiled code reads:
#    evaluation/fraud-spike/results/* (metrics + fitted calibration, served live)
COPY backend/evaluation evaluation

# ---------- runtime ----------
FROM node:20-alpine
WORKDIR /app/backend
ENV NODE_ENV=production

# node_modules/@risk-manager/shared is a SYMLINK: ../../../shared from
# /app/backend/node_modules/@risk-manager/shared, resolving to /app/shared.
# COPY does not follow symlinks, so place the target at that EXACT absolute
# path (not relative to WORKDIR).
COPY --from=build /app/shared /app/shared
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
# Runtime JSON config read from dist/policy/ at boot (tsc does not emit JSON).
COPY backend/src/policy/policy.config.json ./dist/policy/policy.config.json
COPY --from=build /app/backend/evaluation ./evaluation
COPY backend/package.json ./package.json

EXPOSE 3001
CMD ["node", "dist/index.js"]
