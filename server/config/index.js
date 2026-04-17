const path = require('path');
require('dotenv').config();
const { BlobServiceClient } = require('@azure/storage-blob');
const fs = require('fs');

const isWin = process.platform === 'win32';
const isAzureAppService = process.env.WEBSITE_INSTANCE_ID !== undefined; // Set by Azure App Service

// Calculate paths from server directory (one level up from config)
const serverDir = path.dirname(__dirname);  // .../potree/server
const potreeRoot = path.dirname(serverDir); // .../potree

// Resolve PotreeConverter path - handles both directory and full binary paths
let potreeConverterPath;
if (process.env.POTREE_CONVERTER_PATH) {
    const envPath = process.env.POTREE_CONVERTER_PATH;
    // Check if env path is a directory or already a full path to binary
    const stats = fs.existsSync(envPath) ? fs.statSync(envPath) : null;
    
    if (stats && stats.isDirectory()) {
        // User provided directory - append correct binary based on platform
        potreeConverterPath = isWin
            ? path.join(envPath, 'PotreeConverter.exe')
            : path.join(envPath, 'linux', 'PotreeConverter');
    } else {
        // User provided full path to binary
        potreeConverterPath = envPath;
    }
} else {
    // Default paths
    potreeConverterPath = isWin
        ? path.join(potreeRoot, 'PotreeConverter', 'PotreeConverter.exe')
        : path.join(potreeRoot, 'PotreeConverter', 'linux', 'PotreeConverter');
}

const config = {
    port: process.env.PORT || 3000,
    potreeConverterPath: potreeConverterPath,
    uploadsDir: path.join(potreeRoot, 'data', 'uploads'),
    convertedDir: path.join(potreeRoot, 'data', 'converted'),
    tempCloudDir: path.join(potreeRoot, 'data', 'temp'),
    azureProjectsFile: path.join(potreeRoot, 'data', 'azure_projects.json'),

    azure: {
        connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
        rawContainer: process.env.AZURE_RAW_CONTAINER_NAME || 'raw-las',
        convertedContainer: process.env.AZURE_CONVERTED_CONTAINER_NAME || 'converted-potree',
        uploadsContainer: process.env.AZURE_UPLOADS_TEMP_CONTAINER_NAME || 'uploads-temp',
        accountName: null,
        isCloudEnabled: true,
        isAzureAppService: isAzureAppService,
        blobServiceClient: null
    }
};

// Initialize Azure Blob Storage
if (config.azure.connectionString) {
    try {
        config.azure.blobServiceClient = BlobServiceClient.fromConnectionString(
            config.azure.connectionString
        );
        config.azure.accountName = config.azure.blobServiceClient.accountName;
        config.azure.isCloudEnabled = true;
        console.log('✓ Azure Blob Storage integration ENABLED');
        console.log(`  Account: ${config.azure.accountName}`);
        if (config.azure.isAzureAppService) {
            console.log('✓ Running on Azure App Service');
        }
    } catch (err) {
        console.warn('⚠ Azure Blob Storage connection failed:', err.message);
        console.warn('  Falling back to local storage only');
    }
} else if (config.azure.isAzureAppService) {
    console.warn('⚠ Running on Azure App Service but no AZURE_STORAGE_CONNECTION_STRING provided');
    console.warn('  Local storage will be used (data may not persist between deployments)');
}

module.exports = config;
