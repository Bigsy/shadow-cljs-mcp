# Generated by https://smithery.ai. See: https://smithery.ai/docs/config#dockerfile
FROM node:lts-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts
COPY . ./
EXPOSE 9630
ENTRYPOINT ["node", "index.js"]
