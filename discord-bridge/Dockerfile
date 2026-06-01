FROM node:20-alpine

RUN apk add --no-cache curl

# install kubectl
RUN curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
  && chmod +x kubectl && mv kubectl /usr/local/bin/

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY gateway-bridge.mjs .
COPY queue-drainer.mjs .
COPY valkey-watcher.mjs .
CMD ["node", "gateway-bridge.mjs"]

