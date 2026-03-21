# Use a lightweight, official Node.js image
FROM node:22-slim

# Set the working directory inside the container
WORKDIR /app

# Install PM2 globally for process management
RUN npm install -g pm2

# Copy dependency files first (optimizes Docker caching)
COPY package*.json ./

# Install all dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Boot the live engine via PM2. 
# PM2 will use tsx as the interpreter to run our TypeScript code natively.
CMD ["pm2-runtime", "start", "src/ingestion/websocket.ts", "--interpreter", "./node_modules/.bin/tsx", "--name", "quant-router"]