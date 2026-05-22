/**
 * SERVER/INDEX.JS
 * 
 * Express.js Server - Main Backend Entry Point
 * 
 * PURPOSE:
 * - Serves static files (web app, point clouds, libraries)
 * - Routes HTTP requests to API endpoints (/api/*)
 * - Manages file uploads and conversions
 * - Interfaces with Azure Blob Storage for cloud deployments
 * 
 * DEPLOYMENT SCENARIOS:
 * 1. Local Development: Node.js server, local filesystem storage
 * 2. Azure App Service: Node.js on Azure, Blob Storage integration
 * 3. Vercel: Serverless API routes only (no persistent storage)
 * 
 * STATIC ROUTES:
 * /                    -> public/index.html (dashboard)
 * /viewer.html         -> public/viewer.html (point cloud viewer)
 * /examples/*          -> examples/ folder (sample projects)
 * /build/*             -> build/potree/ (compiled library)
 * /libs/*              -> libs/ (Three.js, utilities)
 * /pointclouds/converted/* -> Processed point cloud data
 * 
 * API ROUTES (see server/routes/api.js):
 * POST   /api/upload          -> Upload file
 * GET    /api/list            -> List projects
 * GET    /api/config          -> Server configuration
 * POST   /api/projects        -> Manage projects
 * GET    /api/status/:id      -> Conversion status
 * DELETE /api/delete/:project -> Delete project
 * 
 * MIDDLEWARE STACK:
 * 1. CORS - Allow cross-origin requests
 * 2. JSON Parser - Parse JSON request bodies
 * 3. Logger - Log all HTTP requests
 * 4. Static File Serving - Serve public assets
 * 5. Route Handler - Dispatch to API routes
 * 6. Error Handler - Graceful error responses
 * 
 * PERFORMANCE:
 * - Long timeouts (30 min) for large point cloud conversions
 * - Consider using Redis caching for status queries
 * - Stream uploads for large files (multipart/form-data)
 * 
 * SECURITY:
 * - Validate file uploads (extension, size, mimetype)
 * - Sanitize project names in paths
 * - Restrict file serving to whitelisted directories
 * - Rate limit API endpoints if needed
 */

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

// ============================================================================
// DIRECTORY SETUP
// ============================================================================

/**
 * Ensure all required directories exist.
 * These directories hold uploaded files, converted data, and temporary files.
 */
[config.uploadsDir, config.convertedDir, config.tempCloudDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ============================================================================
// MIDDLEWARE
// ============================================================================

/** Allow cross-origin requests (needed for Vercel API gateway) */
app.use(cors());

/** Parse JSON request bodies */
app.use(express.json());

/**
 * Logger middleware: log all HTTP requests.
 * Format: [timestamp] METHOD /path
 */
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// ============================================================================
// STATIC FILE ROUTES
// ============================================================================

/**
 * Serve the dashboard and web application files.
 * Maps /path to public/path
 */
app.use(express.static(path.join(__dirname, '../public')));

/**
 * Serve processed point cloud data.
 * Maps /pointclouds/converted/* to config.convertedDir
 */
app.use('/pointclouds/converted', express.static(config.convertedDir));

/**
 * Serve example projects and sample data.
 * Maps /examples/* to examples/ folder
 */
app.use('/examples', express.static(path.join(__dirname, '../examples')));

/**
 * Serve compiled Potree library.
 * Maps /build/* to build/ folder
 */
app.use('/build', express.static(path.join(__dirname, '../build')));

/**
 * Serve third-party libraries (Three.js, utilities, etc).
 * Maps /libs/* to libs/ folder
 */
app.use('/libs', express.static(path.join(__dirname, '../libs')));

// ============================================================================
// API ROUTES
// ============================================================================

/**
 * All API endpoints are mounted under /api
 * See server/routes/api.js for individual endpoint implementations
 */
app.use('/api', apiRoutes);

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Global error handler: catch unhandled exceptions and return clean errors.
 * Must be last middleware in the stack.
 */
app.use(errorHandler);

// ============================================================================
// START SERVER
// ============================================================================

/**
 * Start listening on configured port.
 * Sets generous timeouts for long-running point cloud conversions.
 */
const server = app.listen(config.port, () => {
    console.log(`--------------------------------------------------`);
    console.log(`🚀 Potree Cloud Hub running at port ${config.port}`);
    console.log(`📁 Local converted projects: ${config.convertedDir}`);
    console.log(`☁️ Cloud Integration: ${config.azure.isCloudEnabled ? 'ACTIVE' : 'DISABLED'}`);
    console.log(`--------------------------------------------------`);
});

/**
 * Azure App Service and large file conversions need longer timeouts.
 * Default Node.js timeout is 2 minutes; we extend to 30 minutes.
 * 
 * - server.timeout: Socket timeout
 * - keepAliveTimeout: Keep-alive connection timeout
 * - headersTimeout: Headers parsing timeout
 */
server.timeout = 30 * 60 * 1000;
server.keepAliveTimeout = 30 * 60 * 1000;
server.headersTimeout = 31 * 60 * 1000;
