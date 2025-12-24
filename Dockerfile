FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

EXPOSE 8080

CMD ["npm", "start"]
