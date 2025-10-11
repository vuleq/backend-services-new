import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
const s3 = new S3Client({ region: process.env.AWS_REGION });

const allowPath = ['compress', 'results'];

// Validate folder path to prevent directory traversal attacks
function isValidPath(path) {
    return !path.includes('..');
}

export const handler = async (event) => {
    console.log('Event received:', JSON.stringify(event, null, 2));

    const folders = event.folders;
    const bucketName = process.env.DESTINATION_BUCKET;

    if (!bucketName) {
        console.error('DESTINATION_BUCKET environment variable not set');
        return event;
    }

    if (!Array.isArray(folders) || folders.length === 0) {
        console.log('No folders to create');
        return event;
    }

    try {
        // Filter out any undefined or null values
        const validFolders = folders.filter(folder => folder && typeof folder === 'string');
        
        // Pre-filter and validate folders
        const validatedFolders = validFolders
            .filter(folder => isValidPath(folder))
            .map(folder => folder.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-\/]/g, ''))
            .filter(folder => allowPath.some(allowedPath => folder.startsWith(allowedPath)))
            .map(folder => folder.endsWith('/') ? folder : `${folder}/`);

        if (validatedFolders.length === 0) {
            console.log('No valid folders to create after filtering');
            return event;
        }

        // Batch create all folders in parallel
        const results = await Promise.allSettled(
            validatedFolders.map(folder => 
                s3.send(new PutObjectCommand({
                    Bucket: bucketName,
                    Key: folder,
                    Body: '',
                    ContentLength: 0
                }))
            )
        );

        // Log results
        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;
        
        console.log(`Created ${successful} folders successfully, ${failed} failed`);
        
        if (failed > 0) {
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    console.error(`Failed to create ${validatedFolders[index]}:`, result.reason.message);
                }
            });
        }

        return event;
    } catch (error) {
        console.error('Error processing event:', error);
        // Don't fail the auth flow if our resource creation fails
        return event;
    }
};