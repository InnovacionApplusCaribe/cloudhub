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

        const converterProcess = spawn(config.potreeConverterPath, args, {
            env: {
                ...process.env,
                LD_LIBRARY_PATH: `${path.dirname(config.potreeConverterPath)}:${process.env.LD_LIBRARY_PATH || ''}`
            }
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
