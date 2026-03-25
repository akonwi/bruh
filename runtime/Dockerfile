FROM docker.io/cloudflare/sandbox:0.7.20

WORKDIR /app

COPY package.json ./package.json
COPY tsconfig.container.json ./tsconfig.container.json
COPY src ./src

RUN npm install
RUN npx tsc -p tsconfig.container.json

RUN mkdir -p /workspace
COPY .pi /workspace/.pi

# Required so the sandbox can proxy requests to the runtime server.
EXPOSE 3000
