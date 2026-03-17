FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY dist ./dist
COPY node_modules ./node_modules
# Optional: add a custom CA cert for outbound HTTPS via a corporate/sandbox proxy.
# Uncomment and replace with your cert file:
# COPY your-ca.pem /usr/local/share/ca-certificates/custom-ca.crt
# ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/custom-ca.crt
RUN mkdir -p /app/data
CMD ["node", "dist/server.js"]
