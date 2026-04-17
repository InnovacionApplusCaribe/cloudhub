const { spawn } = require('child_process');
const config = require('../config');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const converter = {
    convert(inputPaths, outputPath, onEvent) {
        if (!fs.existsSync(config.potreeConverterPath)) {
            throw new Error(`PotreeConverter not found at ${config.potreeConverterPath}`);
        }

        const inputs = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
        
        // For multiple files, use a list-of-files to avoid command line length limits
        const listFile = path.join(config.uploadsDir, `list-${uuidv4()}.txt`);
        fs.writeFileSync(listFile, inputs.join('\n'));

        const args = ['--list-of-files', listFile, '-o', outputPath, '--generate-page', 'index'];
        console.log(`Executing: ${config.potreeConverterPath} ${args.join(' ')}`);

        const process = spawn(config.potreeConverterPath, args);

        const cleanup = () => {
            if (fs.existsSync(listFile)) {
                fs.unlink(listFile, () => {});
            }
        };

        process.on('error', (err) => {
            cleanup();
            onEvent('error', err);
        });

        process.stdout.on('data', (data) => {
            onEvent('stdout', data.toString());
        });

        process.stderr.on('data', (data) => {
            onEvent('stderr', data.toString());
        });

        process.on('close', (code) => {
            cleanup();
            onEvent('close', code);
        });

        return process;
    }
};

module.exports = converter;
