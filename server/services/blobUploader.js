/**
 * Azure Blob Storage Upload Service
 * Handles uploading converted point clouds to Azure Blob Storage
 * Provides cleanup utilities for local storage management
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const blobUploader = {
    /**
     * Upload converted point cloud directory to Azure Blob Storage
     * @param {string} localPath - Local path to converted directory
     * @param {string} projectName - Project name for blob path prefix
     * @returns {Promise<string|null>} - Cloud URL or null if upload skipped
     */
    async uploadConvertedProject(localPath, projectName) {
        // Validate preconditions
        if (!config.azure.isCloudEnabled) {
            console.log('ℹ Cloud upload skipped: Azure Blob Storage not enabled');
            return null;
        }

        if (!fs.existsSync(localPath)) {
            console.warn(`⚠ Cannot upload: directory not found at ${localPath}`);
            return null;
        }

        try {
            const containerClient = config.azure.blobServiceClient.getContainerClient(
                config.azure.convertedContainer
            );
            
            // Ensure container exists
            await containerClient.createIfNotExists({ access: 'blob' });

            console.log(`📤 Uploading converted project to Azure: ${projectName}`);
            
            // Recursively upload all files
            const uploadRecursive = async (currentLocalPath, currentAzurePrefix) => {
                const items = fs.readdirSync(currentLocalPath, { withFileTypes: true });
                
                for (const item of items) {
                    const fullLocalPath = path.join(currentLocalPath, item.name);
                    const fullAzurePath = currentAzurePrefix + '/' + item.name;

                    if (item.isDirectory()) {
                        // Recursively handle subdirectories
                        await uploadRecursive(fullLocalPath, fullAzurePath);
                    } else {
                        // Upload file with progress logging
                        try {
                            const blockBlobClient = containerClient.getBlockBlobClient(fullAzurePath);
                            const fileSize = fs.statSync(fullLocalPath).size;
                            
                            await blockBlobClient.uploadFile(fullLocalPath);
                            
                            const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
                            console.log(`  ✓ ${fullAzurePath} (${fileSizeMB} MB)`);
                        } catch (fileErr) {
                            console.error(`  ✗ Failed to upload ${fullAzurePath}:`, fileErr.message);
                            throw fileErr;
                        }
                    }
                }
            };

            await uploadRecursive(localPath, projectName);
            
            // Generate and return cloud URL
            const cloudUrl = `https://${config.azure.accountName}.blob.core.windows.net/${config.azure.convertedContainer}/${projectName}/index.html`;
            console.log(`✓ Cloud upload complete: ${cloudUrl}`);
            
            return cloudUrl;
        } catch (err) {
            console.error('✗ Cloud upload failed:', err.message);
            throw err;
        }
    },

    /**
     * Clean up local temporary files after successful Azure upload
     * @param {string} localPath - Local path to delete
     */
    cleanupLocal(localPath) {
        if (!fs.existsSync(localPath)) {
            console.log(`ℹ Path already gone: ${localPath}`);
            return;
        }

        try {
            fs.rmSync(localPath, { recursive: true, force: true });
            console.log(`✓ Cleaned up local directory: ${localPath}`);
        } catch (err) {
            console.error(`✗ Failed to cleanup local directory ${localPath}:`, err.message);
            // Don't throw - cleanup failure shouldn't break the job
        }
    },

    /**
     * Calculate total size of a directory (in bytes)
     * Useful for monitoring disk space usage
     * @param {string} dirPath - Directory path
     * @returns {number} - Total size in bytes
     */
    getDirectorySize(dirPath) {
        let size = 0;

        if (!fs.existsSync(dirPath)) {
            return size;
        }

        const items = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const item of items) {
            const fullPath = path.join(dirPath, item.name);

            if (item.isDirectory()) {
                size += this.getDirectorySize(fullPath);
            } else {
                size += fs.statSync(fullPath).size;
            }
        }

        return size;
    },

    /**
     * Format bytes to human-readable string
     * @param {number} bytes - Size in bytes
     * @returns {string} - Formatted size (e.g., "123.45 MB")
     */
    formatBytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(2)} ${units[unitIndex]}`;
    },

    /**
     * Get storage usage information
     * @param {string} localConverted - Path to local converted directory
     * @returns {Promise<Object>} - Storage usage info
     */
    async getStorageInfo(localConverted) {
        const localSize = this.getDirectorySize(localConverted);

        return {
            localStorageUsed: this.formatBytes(localSize),
            localStorageBytes: localSize,
            cloudEnabled: config.azure.isCloudEnabled,
            cloudContainer: config.azure.convertedContainer,
            timestamp: new Date().toISOString()
        };
    }
};

module.exports = blobUploader;
