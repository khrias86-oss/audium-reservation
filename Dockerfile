# 플랫폼 중립 이미지. Cloud Run(서비스/잡), 일반 VM, 로컬 어디서나 같은 것이 돈다.
#
# Playwright가 필요한지는 M1 정찰이 결정한다:
#   - 사이트가 JSON API를 노출하면 이 슬림 이미지로 충분하다
#   - 렌더링된 DOM이 필요하면 base를
#     mcr.microsoft.com/playwright:v1.49.0-noble 로 바꾼다 (§0.4 경로 B)
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json ./
COPY src ./src

# Cloud Run은 PORT를 주입한다. 다른 곳에서는 기본값 8080을 쓴다.
ENV PORT=8080
EXPOSE 8080

# MODE=server(기본) 또는 MODE=tick
CMD ["npx", "tsx", "src/main.ts"]
