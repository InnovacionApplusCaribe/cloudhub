require('dotenv').config();
const { BlobServiceClient } = require('@azure/storage-blob');

async function setCorsProperties() {
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connStr) {
        console.error('AZURE_STORAGE_CONNECTION_STRING not found in .env');
        return;
    }

    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
        
        console.log('Setting CORS rules for Azure Blob Storage...');
        
        const properties = await blobServiceClient.getProperties();
        
        const newCorsRules = [
            {
                allowedOrigins: '*',
                allowedMethods: 'GET,HEAD,OPTIONS',
                allowedHeaders: '*',
                exposedHeaders: '*',
                maxAgeInSeconds: 86400
            }
        ];
        
        properties.cors = newCorsRules;
        
        await blobServiceClient.setProperties(properties);
        console.log('CORS rules successfully updated to allow all origins for GET, HEAD, and OPTIONS.');
    } catch (err) {
        console.error('Error setting CORS properties:', err.message);
    }
}

setCorsProperties();
