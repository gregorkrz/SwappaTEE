FROM python:3.11-alpine

# Install required dependencies
RUN apk add --no-cache curl openrc

# Install cloudflared
RUN curl -L --output cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && \
    chmod +x cloudflared && \
    mv cloudflared /usr/local/bin/cloudflared

WORKDIR /bot
COPY ./bot.py ./server.py ./requirements.txt /bot
RUN pip install -r requirements.txt

# Create a script to run both cloudflared and the bot
COPY <<EOF /start.sh
#!/bin/sh
# Initialize OpenRC
touch /run/openrc/softlevel

# Run cloudflared directly instead of as a service
cloudflared tunnel run --token eyJhIjoiMzEzZWIwYjhmYjUxZmI3ZmYxOGRhYmY3NWFlNWMwNmYiLCJ0IjoiYmNiMTk0OWItMTU3YS00OGZiLWI5NmEtMjFmNTI0MDJlOWU3IiwicyI6Ik5XTm1NV1l4TkRndE9ESXdOQzAwTURZeExUazNNalF0TjJGaU1qQTBOekkxTXpBdyJ9 &
# Start the HTTP server
python server.py &

# Start the bot
python bot.py
EOF

RUN chmod +x /start.sh

ENTRYPOINT ["/start.sh"]


