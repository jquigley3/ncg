FROM node:22-slim
WORKDIR /app

# Trust the Docker Sandbox proxy CA so npm can reach the registry
RUN apt-get update -qq && apt-get install -y -qq ca-certificates && rm -rf /var/lib/apt/lists/*
COPY docker-sandbox-ca.pem /usr/local/share/ca-certificates/docker-sandbox-ca.crt
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/docker-sandbox-ca.crt

# Install dependencies fresh (builds native modules for Linux)
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output
COPY dist ./dist

RUN mkdir -p /app/data
CMD ["node", "dist/server.js"]
