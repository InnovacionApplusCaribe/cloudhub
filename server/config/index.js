const path = require('path');
require('dotenv').config();
const { BlobServiceClient } = require('@azure/storage-blob');

const isWin = process.platform === 'win32';

const config = {
    port: process.env.PORT || 3000,
    potreeConverterPath: process.env.POTREE_CONVERTER_PATH || (isWin
        ? path.join(__dirname, '../../PotreeConverter/PotreeConverter.exe')
        : path.join(__dirname, '../../PotreeConverter/linux/PotreeConverter')),
    uploadsDir: path.join(__dirname, '../../data/uploads'),
    convertedDir: path.join(__dirname, '../../data/converted'),
    tempCloudDir: path.join(__dirname, '../../data/temp'),
    azureProjectsFile: path.join(__dirname, '../../data/azure_projects.json'),

    azure: {
        connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
        rawContainer: process.env.AZURE_RAW_CONTAINER_NAME || 'raw-las',
        convertedContainer: process.env.AZURE_CONVERTED_CONTAINER_NAME || 'converted-potree',
        accountName: null,
        isCloudEnabled: false,
        blobServiceClient: null
    }
};

// Initialize Azure
if (config.azure.connectionString) {
    try {
        config.azure.blobServiceClient = BlobServiceClient.fromConnectionString(config.azure.connectionString);
        config.azure.accountName = config.azure.blobServiceClient.accountName;
        config.azure.isCloudEnabled = true;
        console.log('Azure Blob Storage integration ENABLED.');
    } catch (err) {
        console.warn('Azure Blob Storage connection failed:', err.message);
    }
}

module.exports = config;
