# Iran Access testing MVP - single small container.
# Runs the token/auth API AND the VLESS-over-WebSocket inbound in ONE node
# process listening on one HTTP port (default 7860) - perfect for platforms
# that only expose HTTP(S) (Hugging Face Spaces, Render, Koyeb, Railway...).
FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY session_server.js session_store.js vless_ws.js token.js smoke_test.js ./

RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user
ENV NODE_ENV=production

EXPOSE 7860
CMD ["node", "session_server.js"]
