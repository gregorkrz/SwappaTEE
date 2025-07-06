FROM node:18-alpine

# Install required dependencies
RUN apk add --no-cache curl

# Install cloudflared
RUN curl -L --output cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && \
    chmod +x cloudflared && \
    mv cloudflared /usr/local/bin/cloudflared

WORKDIR /app

# Copy XRPL TEE server
COPY ./xrpl-tee /app/xrpl-tee
WORKDIR /app/xrpl-tee
# Remove any existing lockfile and node_modules to ensure clean install
RUN rm -f yarn.lock package-lock.json && rm -rf node_modules
RUN yarn install

# Back to main app directory
WORKDIR /app

# Create a script to run services
COPY <<EOF /start.sh
#!/bin/sh

echo "Starting cloudflared tunnel..."
# Run cloudflared in background
cloudflared tunnel run --token eyJhIjoiMzEzZWIwYjhmYjUxZmI3ZmYxOGRhYmY3NWFlNWMwNmYiLCJ0IjoiYmNiMTk0OWItMTU3YS00OGZiLWI5NmEtMjFmNTI0MDJlOWU3IiwicyI6Ik5XTm1NV1l4TkRndE9ESXdOQzAwTURZeExUazNNalF0TjJGaU1qQTBOekkxTXpBdyJ9 &
CLOUDFLARED_PID=\$!
echo "Cloudflared started with PID: \$CLOUDFLARED_PID"

echo "Starting XRPL TEE server..."
# Start XRPL TEE server (this will run in foreground)
cd /app/xrpl-tee
yarn start
EOF

RUN chmod +x /start.sh

# Health check for XRPL TEE server
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/start.sh"]


