FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production
# La base (turnos, pedidos, conversaciones y respaldos) vive acá: montá un volumen persistente en /app/data.
VOLUME /app/data
EXPOSE 3000
CMD ["npm", "start"]
