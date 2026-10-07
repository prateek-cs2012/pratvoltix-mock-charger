FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @pratvoltix/mock-charger... build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
CMD ["node", "apps/mock-charger/dist/index.js"]
