FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json ./
COPY node_modules ./node_modules
COPY . .

RUN npm run build

ENV SQLITE_PATH=/data/promptmanager.db
EXPOSE 4173
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "4173"]
