# App container: Node 24 runs the TypeScript sources directly (type stripping).
# The DSH runtime is spawned from node_modules/@deepseek-ai/dsh per research stage.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production \
    DSH_HOME=/tmp/dsh-home \
    PORT=8080

COPY package.json package-lock.json ./
# --ignore-scripts: DSH's optional native terminal (node-pty) is not used; the
# research profile disables every shell tool.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY dsh ./dsh

USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
