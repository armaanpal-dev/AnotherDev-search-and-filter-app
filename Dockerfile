# AnotherDev Search & Filters — production image for Fly.io / any container host.
FROM node:20-alpine

# openssl is required by Prisma; libc6-compat helps some native deps on alpine.
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app
ENV NODE_ENV=production

# Install ALL deps (build needs vite / @react-router/dev, which are devDeps).
COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force

# App source
COPY . .

# Generate the Prisma client and build the app.
RUN npx prisma generate && npm run build

# Drop dev-only deps to slim the runtime image (keeps @prisma/client, prisma CLI,
# @react-router/serve — all in "dependencies").
RUN npm prune --omit=dev

EXPOSE 3000
# Migrations run via Fly's release_command, so the start command is just the server.
CMD ["npm", "run", "start"]
