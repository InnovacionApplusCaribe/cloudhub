/**
 * Startup Initialization Script
 * Runs on application start to ensure proper environment setup
 * Handles:
 * - Directory creation
 * - Binary permissions (Linux/Azure)
 * - Logging initialization
 */

const fs = require('fs');
const path = require('path');

console.log('🔧 Running startup initialization...');

// Fix permissions on PotreeConverter binary (Linux only)
if (process.platform !== 'win32') {
    const binPath = path.join(__dirname, '../PotreeConverter/linux/PotreeConverter');
    if (fs.existsSync(binPath)) {
        try {
            fs.chmodSync(binPath, 0o755);
            console.log('✓ PotreeConverter binary permissions set to 0755 (executable)');
        } catch (err) {
            console.warn('⚠ Could not set permissions on PotreeConverter:', err.message);
        }
    } else {
        console.warn('⚠ PotreeConverter binary not found at:', binPath);
    }
} else {
    // Windows - verify .exe exists
    const binPath = path.join(__dirname, '../PotreeConverter/PotreeConverter.exe');
    if (!fs.existsSync(binPath)) {
        console.warn('⚠ PotreeConverter.exe not found at:', binPath);
    } else {
        console.log('✓ PotreeConverter.exe found');
    }
}

// Ensure core directories exist
const dirs = [
    path.join(__dirname, '../data/uploads'),
    path.join(__dirname, '../data/converted'),
    path.join(__dirname, '../data/temp')
];

dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
            console.log(`✓ Created directory: ${path.relative(__dirname, dir)}`);
        } catch (err) {
            console.error(`✗ Failed to create directory ${dir}:`, err.message);
        }
    } else {
        console.log(`✓ Directory exists: ${path.relative(__dirname, dir)}`);
    }
});

// Verify data directory structure
try {
    const dataDir = path.join(__dirname, '../data');
    if (fs.existsSync(dataDir)) {
        const contents = fs.readdirSync(dataDir);
        console.log(`📁 Data directory contents: ${contents.join(', ')}`);
    }
} catch (err) {
    console.warn('⚠ Could not list data directory:', err.message);
}

console.log('✓ Startup initialization complete\n');
