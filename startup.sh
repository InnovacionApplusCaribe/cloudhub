#!/bin/bash
# Azure App Service startup script
# Installs runtime dependencies for PotreeConverter

echo "Installing PotreeConverter runtime dependencies..."

if command -v apt-get &> /dev/null; then
    apt-get update
    apt-get install -y liblas1 laszip-bin libzip4
    echo "✓ Dependencies installed"
fi

# Make binary executable
chmod +x /home/site/wwwroot/PotreeConverter/linux/PotreeConverter 2>/dev/null || true

echo "Starting Node.js application..."
exec node /home/site/wwwroot/server/index.js
