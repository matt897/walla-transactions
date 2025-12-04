# Use official Node image (includes docker-entrypoint.sh)
FROM node:18-slim

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install && npx playwright install --with-deps chromium

# Copy app code
COPY . .

EXPOSE 8082

# Let default ENTRYPOINT run, but tell it to start server.js
CMD ["node", "server.js"]
