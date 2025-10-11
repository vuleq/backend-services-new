import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
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
        console.error('BUCKET_NAME environment variable not set');
        return event;
    }

    if (!Array.isArray(folders) || folders.length === 0) {
        console.log('No folders to delete');
        return event;
    }

    try {
        // Filter out any undefined or null values
        const validFolders = folders.filter(folder => folder && typeof folder === 'string');
        
        const deleteFolderPromises = validFolders.map(async (folder) => {
            // Validate and sanitize folder path
            if (!isValidPath(folder)) {
                console.log(`Skipping folder deletion for ${folder} - invalid path`);
                return Promise.resolve();
            }
            
            // Sanitize folder path and check if it starts with any of the allowed paths
            const sanitizedFolder = folder.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-\/]/g, '');
            const isAllowed = allowPath.some(allowedPath => sanitizedFolder.startsWith(allowedPath));
            
            if (!isAllowed) {
                console.log(`Skipping folder deletion for ${folder} - not in allowed paths`);
                return Promise.resolve();
            }

            try {
                const folderPrefix = sanitizedFolder.endsWith('/') ? sanitizedFolder : `${sanitizedFolder}/`;
                
                // List all objects in the folder
                const listCommand = new ListObjectsV2Command({
                    Bucket: bucketName,
                    Prefix: folderPrefix
                });
                
                const listResponse = await s3.send(listCommand);
                
                if (listResponse.Contents && listResponse.Contents.length > 0) {
                    // Prepare objects for deletion
                    const objectsToDelete = listResponse.Contents.map(obj => ({ Key: obj.Key }));
                    
                    // Delete all objects in batches (S3 allows max 1000 objects per delete request)
                    const batchSize = 1000;
                    for (let i = 0; i < objectsToDelete.length; i += batchSize) {
                        const batch = objectsToDelete.slice(i, i + batchSize);
                        
                        const deleteCommand = new DeleteObjectsCommand({
                            Bucket: bucketName,
                            Delete: {
                                Objects: batch,
                                Quiet: true // Don't return deleted object info to reduce response size
                            }
                        });
                        
                        await s3.send(deleteCommand);
                    }
                    
                    console.log(`Successfully deleted ${objectsToDelete.length} objects from folder: ${folder}`);
                } else {
                    console.log(`No objects found in folder: ${folder}`);
                }
                
            } catch (error) {
                console.error(`Failed to delete folder ${folder}:`, error);
                // Continue with other folders even if one fails
            }
        });

        await Promise.all(deleteFolderPromises);

        console.log(`Completed processing folder deletions: ${folders.join(', ')}`);

        return event;
    } catch (error) {
        console.error('Error processing event:', error);
        // Don't fail the flow if our resource deletion fails
        return event;
    }
};