FROM oven/bun:1-alpine

WORKDIR /app
ENV NODE_ENV=production

# No runtime dependencies: Bun ships the HTTP server and the S3 client.
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["bun", "run", "src/server.ts"]
