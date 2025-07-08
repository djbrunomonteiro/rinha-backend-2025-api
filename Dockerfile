FROM node:22

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN npm run build

CMD ["node", "dist/main"]
