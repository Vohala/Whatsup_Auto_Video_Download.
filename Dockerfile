FROM node:20-bookworm

# Install system dependencies with Python 3.11
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-sandbox \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Verify Python version (should be 3.11+ in bookworm)
RUN python3 --version

# Install latest yt-dlp via pip
RUN pip3 install --no-cache-dir --upgrade pip --break-system-packages
RUN pip3 install --no-cache-dir --upgrade yt-dlp --break-system-packages

# Configure Puppeteer
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create required directories
RUN mkdir -p sessions downloads public

# Create appuser with home directory and proper permissions
RUN groupadd -r appuser && \
    useradd -r -g appuser -d /home/appuser -m appuser && \
    chown -R appuser:appuser /app && \
    chown -R appuser:appuser /home/appuser

# Set yt-dlp cache to writable location
ENV XDG_CACHE_HOME=/app/.cache
RUN mkdir -p /app/.cache && chown -R appuser:appuser /app/.cache

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); });"

# Start application
CMD ["node", "server.js"]
