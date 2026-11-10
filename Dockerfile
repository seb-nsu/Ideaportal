# One image for internal operation and the EU cloud (R1-01).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# The runtime only needs node. npm, npx, corepack and yarn ship with the base image and bring
# their own dependencies, which the image scan (Trivy) reports; the app never calls them.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
# Build commit, shown by GET /api/version (docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD)).
ARG GIT_COMMIT=""
LABEL org.opencontainers.image.revision=$GIT_COMMIT
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/web/dist GIT_COMMIT=$GIT_COMMIT
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/server/testset server/testset
COPY --from=build /app/server/templates server/templates
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/api/health/ready || exit 1
CMD ["node", "server/dist/main.js"]
