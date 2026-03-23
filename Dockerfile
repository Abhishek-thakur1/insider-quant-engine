FROM node:22-slim

WORKDIR /app

RUN npm install -g pm2

COPY package*.json ./
RUN npm install
COPY . .