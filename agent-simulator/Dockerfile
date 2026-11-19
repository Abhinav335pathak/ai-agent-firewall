# syntax=docker/dockerfile:1
FROM node:22-alpine
WORKDIR /app
COPY package.json simulate.js ./
USER node
ENTRYPOINT ["node", "simulate.js"]
