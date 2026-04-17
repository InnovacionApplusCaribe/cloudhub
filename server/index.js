// Load startup initialization (must be first)
require('./startup');

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const apiRoutes = require('./routes/api');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Ensure core directories exist
[config.uploadsDir, config.convertedDir, config.tempCloudDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Logger
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Static files
app.use(express.static(path.join(__dirname, '../public')));
app.use('/pointclouds/converted', express.static(config.convertedDir));
app.use('/examples', express.static(path.join(__dirname, '../examples')));
app.use('/build', express.static(path.join(__dirname, '../build')));
app.use('/libs', express.static(path.join(__dirname, '../libs')));

// Routes
app.use('/api', apiRoutes);

// Error Handling
app.use(errorHandler);

// Start Server
const server = app.listen(config.port, () => {
    console.log(`--------------------------------------------------`);
    console.log(`🚀 Potree Cloud Hub running at port ${config.port}`);
    console.log(`📁 Local converted projects: ${config.convertedDir}`);
    console.log(`☁️ Cloud Integration: ${config.azure.isCloudEnabled ? 'ACTIVE' : 'DISABLED'}`);
    console.log(`--------------------------------------------------`);
});

// Azure App Service timeouts (30 mins for massive lidar tasks)
server.timeout = 30 * 60 * 1000;
server.keepAliveTimeout = 30 * 60 * 1000;
server.headersTimeout = 31 * 60 * 1000;
