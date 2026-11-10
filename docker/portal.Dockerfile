FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY --chmod=0755 apps ./apps
RUN npm run generate && npm run build
COPY scripts/portal-entrypoint.sh /usr/local/bin/portal-entrypoint
RUN chmod 755 /usr/local/bin/portal-entrypoint
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/portal-entrypoint"]
