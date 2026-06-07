FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node src/ ./src/
# No npm deps needed — pure Node.js built-ins only
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]
