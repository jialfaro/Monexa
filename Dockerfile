FROM node:22-slim

WORKDIR /app

# Instalar dependencias
COPY package*.json ./
RUN npm install --omit=dev

# Copiar código fuente
COPY . .

# Exponer el puerto por defecto de Monexa
EXPOSE 4173
ENV PORT=4173
ENV HOST=0.0.0.0

CMD ["node", "server.mjs"]
