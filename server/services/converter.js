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
        
        // Validate all input files exist
        const missingFiles = inputs.filter(f => !fs.existsSync(f));
        if (missingFiles.length > 0) {
            console.error('[Converter] Missing input files:', missingFiles);
            throw new Error(`${missingFiles.length} input file(s) not found`);
        }
        
        // For multiple files, use a list-of-files to avoid command line length limits
        const listFile = path.join(config.uploadsDir, `list-${uuidv4()}.txt`);
        // Write file paths with absolute paths to avoid issues
        const fileListContent = inputs.map(f => path.resolve(f)).join('\n');
        fs.writeFileSync(listFile, fileListContent);
        
        // Verify list file was created correctly
        const writtenContent = fs.readFileSync(listFile, 'utf8');
        const writtenLines = writtenContent.split('\n').filter(l => l.trim());
        console.log(`[Converter] List file created with ${writtenLines.length} file(s): ${listFile}`);
        if (writtenLines.length !== inputs.length) {
            console.warn(`[Converter] Warning: Expected ${inputs.length} files but list has ${writtenLines.length}`);
        }
        writtenLines.forEach((line, idx) => {
            console.log(`  [${idx + 1}] ${line}`);
        });

        const args = ['--list-of-files', listFile, '-o', outputPath, '--generate-page', 'index'];
        console.log(`[Converter] Executing: ${config.potreeConverterPath} ${args.join(' ')}`);
        console.log(`[Converter] Processing ${inputs.length} file(s) with output: ${outputPath}`);

        const converterProcess = spawn(config.potreeConverterPath, args, {
            env: {
                ...process.env,
                LD_LIBRARY_PATH: `${path.dirname(config.potreeConverterPath)}:${process.env.LD_LIBRARY_PATH || ''}`
            },
            // Increase buffer size for large conversions
            maxBuffer: 50 * 1024 * 1024, // 50MB instead of default 1MB
            timeout: 30 * 60 * 1000 // 30 minute timeout for large batches
        });
        let stdoutData = '';
        let stderrData = '';

        const cleanup = () => {
            if (fs.existsSync(listFile)) {
                fs.unlink(listFile, () => {});
            }
        };

        converterProcess.on('error', (err) => {
            console.error(`[Converter] Process error:`, err.message);
            cleanup();
            onEvent('error', err);
        });

        converterProcess.stdout.on('data', (data) => {
            const text = data.toString();
            stdoutData += text;
            console.log(`[Converter stdout] ${text}`);
            onEvent('stdout', data);
        });

        converterProcess.stderr.on('data', (data) => {
            const text = data.toString();
            stderrData += text;
            console.error(`[Converter stderr] ${text}`);
            onEvent('stderr', data);
        });

        converterProcess.on('close', (code) => {
            console.log(`[Converter] Process closed with exit code: ${code}`);
            if (stderrData) console.error(`[Converter] Final stderr: ${stderrData}`);
            if (stdoutData && code !== 0) console.log(`[Converter] Final stdout: ${stdoutData}`);
            cleanup();
            onEvent('close', code);
        });

        converterProcess.on('exit', (code, signal) => {
            console.log(`[Converter] Process exit event - code: ${code}, signal: ${signal}`);
        });

        return converterProcess;
    }
};

module.exports = converter;
