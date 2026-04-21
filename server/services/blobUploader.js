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
     * Upload file to blob storage with retry logic
     * @private
     */
    async uploadFileWithRetry(blockBlobClient, localPath, azurePath, maxRetries = 3) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const fileSize = fs.statSync(localPath).size;
                await blockBlobClient.uploadFile(localPath);
                
                const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
                console.log(`  ✓ ${azurePath} (${fileSizeMB} MB)`);
                return true;
            } catch (err) {
                lastError = err;
                console.warn(`  ⚠ Attempt ${attempt}/${maxRetries} failed for ${azurePath}: ${err.message}`);
                
                if (attempt < maxRetries) {
                    // Exponential backoff: 1s, 2s, 4s
                    const delayMs = 1000 * Math.pow(2, attempt - 1);
                    console.log(`  ⏱ Retrying in ${delayMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }
        
        console.error(`  ✗ Failed to upload ${azurePath} after ${maxRetries} attempts: ${lastError.message}`);
        return false;
    },

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
            
            // Track upload statistics
            const stats = {
                totalFiles: 0,
                successfulFiles: 0,
                failedFiles: 0,
                failedPaths: []
            };
            
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
                        // Upload file with retry logic - CONTINUE ON FAILURES
                        stats.totalFiles++;
                        try {
                            const blockBlobClient = containerClient.getBlockBlobClient(fullAzurePath);
                            const success = await this.uploadFileWithRetry(blockBlobClient, fullLocalPath, fullAzurePath);
                            
                            if (success) {
                                stats.successfulFiles++;
                            } else {
                                stats.failedFiles++;
                                stats.failedPaths.push(fullAzurePath);
                            }
                        } catch (fileErr) {
                            // Catch unexpected errors and continue with next file
                            console.error(`  ✗ Unexpected error uploading ${fullAzurePath}:`, fileErr.message);
                            stats.failedFiles++;
                            stats.failedPaths.push(fullAzurePath);
                        }
                    }
                }
            };

            await uploadRecursive(localPath, projectName);
            
            // Report statistics
            console.log(`\n📊 Upload Summary:`);
            console.log(`  Total files: ${stats.totalFiles}`);
            console.log(`  Successful: ${stats.successfulFiles}`);
            console.log(`  Failed: ${stats.failedFiles}`);
            
            if (stats.failedFiles > 0) {
                console.warn(`⚠ ${stats.failedFiles} file(s) failed to upload:`);
                stats.failedPaths.forEach(p => console.warn(`    - ${p}`));
            }
            
            // Only throw error if ALL files failed
            if (stats.successfulFiles === 0 && stats.totalFiles > 0) {
                throw new Error('Cloud upload failed: No files could be uploaded');
            }
            
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
