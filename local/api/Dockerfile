FROM node:22-alpine
WORKDIR /app
ENV HOST=0.0.0.0
COPY package*.json ./
RUN npm ci --omit=dev
COPY schema.sql ./
COPY src ./src
USER node
EXPOSE 3001
CMD ["node", "src/index.js"]
