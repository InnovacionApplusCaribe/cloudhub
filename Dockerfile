FROM node:18-alpine

WORKDIR /app

# Install PotreeConverter runtime dependencies
RUN apk add --no-cache \
    liblas \
    laszip

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm ci --omit=dev && npm run build

# Copy application code
COPY server ./server
COPY public ./public
COPY resources ./resources
COPY PotreeConverter ./PotreeConverter
COPY build ./build

# Create data directories
RUN mkdir -p data/uploads data/converted data/temp && \
    chmod +x PotreeConverter/linux/PotreeConverter || true

# Expose port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production

# Start app
CMD ["node", "server/index.js"]
