FROM node:20-slim

RUN apt-get update && \
    apt-get install -y graphicsmagick ghostscript && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install
RUN npx playwright install --with-deps chromium

COPY . .
RUN npm run build

EXPOSE 8080
CMD ["node", "dist/app.js"]
