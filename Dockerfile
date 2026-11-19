FROM node:24-slim AS build
WORKDIR /app
COPY . .
RUN node scripts/build.mjs

FROM node:24-slim
ENV PORT=8000
WORKDIR /app
# serve.mjs resolves dist/ as <its dir>/../dist, so keep this layout.
COPY --from=build /app/dist /app/dist
COPY scripts/serve.mjs /app/scripts/serve.mjs
EXPOSE 8000
CMD ["node", "scripts/serve.mjs"]
