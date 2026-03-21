# Use a lightweight, official Node.js image
FROM node:22-slim

# Set the working directory inside the container
WORKDIR /app

# Copy dependency files first (optimizes Docker caching)
COPY package*.json ./

# Install all dependencies (including dev dependencies like tsx)
RUN npm install

# Copy the rest of the application code
COPY . .

# Keep the container awake infinitely so we can run scripts inside it manually
CMD ["tail", "-f", "/dev/null"]