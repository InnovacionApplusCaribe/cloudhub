// List actual blobs in Azure container - run from potree project root
const path = require('path');
require(path.join(__dirname, '..', '..', '..', '..', '..', '..', 'Documents', 'dev', 'Potree_project', 'potree', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', '..', '..', '..', '..', '..', 'Documents', 'dev', 'Potree_project', 'potree', '.env') });
const { BlobServiceClient } = require(path.join(__dirname, '..', '..', '..', '..', '..', '..', 'Documents', 'dev', 'Potree_project', 'potree', 'node_modules', '@azure', 'storage-blob'));

async function main() {
    const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
    const containerClient = blobServiceClient.getContainerClient('cloudhub-converter');
    
    const prefix = 'Circuito_34-23_cce0901b';
    console.log(`\nListing blobs with prefix: ${prefix}/\n`);
    
    let count = 0;
    for await (const blob of containerClient.listBlobsFlat({ prefix: prefix })) {
        console.log(`  ${blob.name}`);
        count++;
        if (count > 50) {
            console.log('  ... (truncated, more blobs exist)');
            break;
        }
    }
    console.log(`\nTotal blobs found: ${count}`);
}

main().catch(err => console.error('Error:', err.message));
