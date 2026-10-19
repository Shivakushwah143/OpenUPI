# syntax=docker/dockerfile:1
# YOUPI PG V2 — staging runtime image.
#
# Node 22 is the current LTS line. node:sqlite is unflagged from 22.13.0 onwards,
# which the gateway's database layer requires.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Workspace manifests only, so source edits do not invalidate the dependency layer.
COPY package.json package-lock.json ./
COPY packages/common/package.json ./packages/common/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/observer-sdk/package.json ./packages/observer-sdk/
COPY packages/merchant-sdk/package.json ./packages/merchant-sdk/
COPY apps/payment-api/package.json ./apps/payment-api/
COPY apps/checkout-portal/package.json ./apps/checkout-portal/
COPY apps/merchant-admin/package.json ./apps/merchant-admin/
COPY apps/sms-observer/package.json ./apps/sms-observer/
COPY apps/gmail-observer/package.json ./apps/gmail-observer/
COPY apps/control-center/package.json ./apps/control-center/
COPY apps/coin-wallet-store/package.json ./apps/coin-wallet-store/
COPY apps/payment-help/package.json ./apps/payment-help/
COPY apps/android-observer-app/package.json ./apps/android-observer-app/

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

# Application source (no .env, no data, no node_modules from the host context).
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps ./apps

# Persistent SQLite location. A named volume is mounted here by compose.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data

USER node

EXPOSE 6100 7000 6001

# Default service; compose overrides the command per container.
CMD ["node", "apps/payment-api/src/index.js"]
