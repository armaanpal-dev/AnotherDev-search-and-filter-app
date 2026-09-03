# AnotherDev Search & Filters — production image for Railway / Fly.io / any
# container host.
FROM node:20-alpine

# openssl is required by Prisma; libc6-compat helps some native deps on alpine.
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app
ENV NODE_ENV=production

# Install ALL deps (build needs vite / @react-router/dev, which are devDeps).
COPY package.json package-lock.json* ./

# scripts/ MUST land before `npm ci`. package.json runs a postinstall hook
# (scripts/patch-shopify-types.mjs), and npm executes it as part of `npm ci` —
# so with only the manifests copied, npm ci died with "Cannot find module"
# before the rest of the source was ever added. Its own layer so it does not
# bust the dependency cache on every source change.
COPY scripts ./scripts

RUN npm ci && npm cache clean --force

# App source
COPY . .

# Generate the Prisma client and build the app.
RUN npx prisma generate && npm run build

# Drop dev-only deps to slim the runtime image (keeps @prisma/client, prisma CLI,
# @react-router/serve — all in "dependencies").
RUN npm prune --omit=dev

EXPOSE 3000

# Just the server: schema changes are applied once per deploy by the host's
# release hook (Fly's `release_command`, Railway's Pre-deploy Command), not on
# every container start. If your host has no such hook, switch this to
# `npm run docker-start`, which runs migrations first and then starts.
CMD ["npm", "run", "start"]
