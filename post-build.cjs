const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const deployDir = path.join(__dirname, 'deploy');
const nodeModulesDir = path.join(deployDir, 'node_modules');
const libsDir = path.join(deployDir, 'libs');
const htmlFile = path.join(deployDir, 'index.html');
const htmlGzFile = path.join(deployDir, 'index.html.gz');

function run() {
    console.log('Running post-build script...');

    // 1. Rename node_modules to libs inside deploy/
    if (fs.existsSync(nodeModulesDir)) {
        if (fs.existsSync(libsDir)) {
            // Clean up existing libs dir if any
            fs.rmSync(libsDir, { recursive: true, force: true });
        }
        fs.renameSync(nodeModulesDir, libsDir);
        console.log('Successfully renamed deploy/node_modules to deploy/libs');
    } else {
        console.log('deploy/node_modules not found, skipping rename.');
    }

    // 2. Update index.html to point to libs/ instead of node_modules/
    if (fs.existsSync(htmlFile)) {
        let htmlContent = fs.readFileSync(htmlFile, 'utf8');
        
        // Replace paths
        const updatedHtml = htmlContent.replace(/\.\/node_modules\//g, './libs/');
        
        if (htmlContent !== updatedHtml) {
            fs.writeFileSync(htmlFile, updatedHtml, 'utf8');
            console.log('Successfully updated index.html importmaps.');

            // 3. Re-compress index.html to index.html.gz
            if (fs.existsSync(htmlGzFile)) {
                const buffer = fs.readFileSync(htmlFile);
                const gzipped = zlib.gzipSync(buffer);
                fs.writeFileSync(htmlGzFile, gzipped);
                console.log('Successfully re-compressed index.html.gz');
            }
        } else {
            console.log('No node_modules references found in index.html.');
        }
    } else {
        console.error('Error: index.html not found in deploy directory!');
    }
}

run();
