FROM node:20-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app/backend

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

EXPOSE 10000

CMD ["node", "server.js"]
