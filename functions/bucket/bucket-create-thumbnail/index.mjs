import sharp from 'sharp';
import { executeQuery, insertRecord } from 'wdr-connect-db';
import { isValidUUID, isValidCognitoSub } from 'wdr-common-utils';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

// Custom error classes for better error handling
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

class ResourceNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

const s3 = new S3Client({ region: process.env.AWS_REGION });

const DESTINATION_BUCKET = process.env.DESTINATION_BUCKET;
const SUPPORTED_FORMATS = ['webp', 'jpeg', 'png', 'jpg'];

const originalsFolder = 'originals';
const compressFolder = 'compress';

// Cache for global settings to avoid repeated DB queries
let globalSettingsCache = null;
let cacheTimestamp = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// quotation for upload file in project
const actionEnum = { 'quotation': 0, 'job': 1, 'report': 2 }

const reportType = Object.freeze({
    TEMPLATE: 0,
    HEADER: 1,
    FOOTER: 2,
    REPORT: 3,
    COVER: 4
});

const MaxCompressLevel = 'IMAGE_COMPRESSIVE_LEVEL';
const MaxUploadImageSize = 'MAX_UPLOAD_IMAGE_SIZE';

async function getGlobalSettings() {
    const now = Date.now();

    if (globalSettingsCache && cacheTimestamp && (now - cacheTimestamp) < CACHE_TTL) {
        return globalSettingsCache;
    }

    const selectSql = 'SELECT value, code FROM app_settings WHERE code = ANY($1)';
    const settings = await executeQuery(selectSql, [MaxCompressLevel, MaxUploadImageSize]);

    if (settings.success && settings.data) {
        globalSettingsCache = {
            maxCompress: 50,
            maxSize: 20
        };
        const resultData = settings.data;
        resultData.forEach(element => {
            if (element.code === MaxCompressLevel) {
                globalSettingsCache.maxCompress = Number(element.value);
            } else {
                globalSettingsCache.maxSize = Number(element.value);
            }
        });
        cacheTimestamp = now;
        return globalSettingsCache;
    }

    // Return defaults if DB query fails
    return { maxCompress: 50, maxSize: 20 };
}

export const handler = async (event) => {
    console.log('Receive event', event);

    if (!DESTINATION_BUCKET) {
        console.error('DESTINATION_BUCKET environment variable is not set.');
        throw new Error('Configuration error: Destination bucket not set.');
    }

    if (!event.Records?.[0]) {
        console.error('No S3 record found in event');
        return { statusCode: 400, body: 'Invalid event format' };
    }

    try {
        const record = event.Records[0];
        const srcBucket = record.s3.bucket.name;
        const srcKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
        const imageType = srcKey.split('.').pop()?.toLowerCase();

        // Skip if not in originals folder to prevent recursive triggers
        if (!srcKey.startsWith(`${originalsFolder}/`)) {
            console.log('Not an original image, skipping processing');
            return { statusCode: 200, body: 'Skipped - not in originals folder' };
        }

        if (!imageType || !SUPPORTED_FORMATS.includes(imageType)) {
            console.log(`Unsupported image type: ${imageType}, skipping processing`);
            return { statusCode: 200, body: 'Skipped - unsupported format' };
        }

        // document/originals/image.jpg
        const pathParts = srcKey.split('/');
        const fileName = pathParts[pathParts.length - 1];

        // Get image from S3
        const { Body, ContentType, Metadata } = await s3.send(new GetObjectCommand({
            Bucket: srcBucket,
            Key: srcKey
        }));

        if (Metadata?.compressed === 'true') {
            console.log('Image already compressed, skipping');
            return { statusCode: 200, body: 'Skipped - already processed' };
        }

        const { action, user_id, job_id, report_id } = Metadata;
        let projectId;
        let subPath;

        // Validate required metadata fields
        try {
            validateMetadata(action, user_id, job_id, report_id);
        } catch (error) {
            console.error(`Metadata validation error: ${error.message}`);
            return { statusCode: 200, body: `Skipped - ${error.message}` };
        }

        // Validate user exists in database
        try {
            await validateUserExists(user_id);
        } catch (error) {
            console.error(`User validation error: ${error.message}`);
            return { statusCode: 200, body: `Skipped - ${error.message}` };
        }

        // Get project ID based on action type
        try {
            const result = await getProjectInfo(action, job_id, report_id);
            projectId = result.projectId;
            subPath = result.subPath;
        } catch (error) {
            console.error(`Project info error: ${error.message}`);
            return { statusCode: 200, body: `Skipped - ${error.message}` };
        }

        // Check compressed location existed
        const compressFileFolder = `${compressFolder}/${projectId}/${subPath}`;
        
        // Check compress folder exists
        const compressFolderExists = await isFolderExisted(compressFileFolder, DESTINATION_BUCKET);
        
        if (!compressFolderExists) {
            throw new ResourceNotFoundError('Target compress folder does not exist');
        }

        const imageBuffer = await Body.transformToByteArray();

        // Get global settings with caching
        const { maxSize, maxCompress } = await getGlobalSettings();
        console.log(`Using max compress quality: ${maxCompress}%`);

        // Check file size against maxSize limit (in MB)
        const fileSizeInMB = imageBuffer.length / (1024 * 1024);
        if (maxSize && fileSizeInMB > maxSize) {
            console.log(`File size ${fileSizeInMB.toFixed(2)}MB exceeds limit ${maxSize}MB, skipping processing`);
            return { statusCode: 200, body: `Skipped - file size ${fileSizeInMB.toFixed(2)}MB exceeds ${maxSize}MB limit` };
        }

        // Compress all images using the quality setting
        let processedBuffer;
        switch (imageType) {
            case 'webp':
                processedBuffer = await sharp(imageBuffer)
                    .webp({ quality: maxCompress, lossless: false })
                    .toBuffer();
                break;
            case 'jpeg':
            case 'jpg':
                processedBuffer = await sharp(imageBuffer)
                    .jpeg({ quality: maxCompress, progressive: true })
                    .toBuffer();
                break;
            case 'png':
                processedBuffer = await sharp(imageBuffer)
                    .png({ compressionLevel: Math.round((100 - maxCompress) / 10) })
                    .toBuffer();
                break;
            default:
                processedBuffer = imageBuffer;
        }

        const compressFileKey = compressFileFolder + `/${fileName}`;
        const insertFileResult = await insertRecord('files', {
            s3_url: compressFileKey,
            file_name: fileName,
            file_type: imageType,
            file_size_bytes: processedBuffer.length,
            uploaded_by: user_id,
            uploaded_at: new Date().toISOString(),
            project_id: projectId,
            job_id: actionEnum[action] === actionEnum['job'] ? subPath : null,
            report_id: actionEnum[action] === actionEnum['report'] ? subPath : null
        });

        if (insertFileResult.success) {
            console.log(`File record inserted successfully: ${fileName}`);
        } else {
            console.error(`Failed to insert file record: ${fileName}`);
            return { statusCode: 200, body: 'Skipped - Failed to insert file record' };
        }

        await s3.send(new PutObjectCommand({
            Bucket: DESTINATION_BUCKET,
            Key: compressFileKey,
            Body: processedBuffer,
            ContentType: ContentType || (imageType === 'jpg' ? 'image/jpeg' : `image/${imageType}`),
            Metadata: {
                ...Metadata,
                compressed: 'true'
            }
        }));

        console.log(`Saved compressed file: ${compressFileKey}`);

        // Delete original file
        await s3.send(new DeleteObjectCommand({
            Bucket: srcBucket,
            Key: srcKey
        }));

        console.log(`Deleted original file: ${srcKey}`);

        return {
            statusCode: 200,
            body: JSON.stringify('Image compressed successfully'),
        };

    } catch (error) {
        console.error('Error processing S3 event:', error);
        
        // Classify errors for better monitoring and debugging
        if (error.name === 'ValidationError') {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: error.message })
            };
        } else if (error.name === 'ResourceNotFoundError') {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: error.message })
            };
        } else {
            // For unexpected errors, let Lambda handle the retry logic
            throw error;
        }
    }
};

/**
 * Validates metadata fields for image processing
 * @param {string} action - Action type (job, report, etc.)
 * @param {string} userId - User ID
 * @param {string} jobId - Optional job ID
 * @param {string} reportId - Optional report ID
 * @throws {ValidationError} If validation fails
 */
function validateMetadata(action, userId, jobId, reportId) {
    if (!action || !userId) {
        throw new ValidationError('missing required metadata: user_id, action');
    }
    
    if (!actionEnum[action]) {
        throw new ValidationError(`action is not valid: ${action}`);
    }
    
    if (!isValidCognitoSub(userId)) {
        throw new ValidationError(`user_id is not valid: ${userId}`);
    }
    
    if (actionEnum[action] === actionEnum['job'] && (!jobId || !isValidUUID(jobId))) {
        throw new ValidationError('required metadata job_id not valid');
    }
    
    if (actionEnum[action] === actionEnum['report'] && (!reportId || !isValidUUID(reportId))) {
        throw new ValidationError('required metadata report_id not valid');
    }
}

/**
 * Validates that a user exists in the database
 * @param {string} userId - User ID to validate
 * @throws {ValidationError} If user validation fails
 */
async function validateUserExists(userId) {
    const checkUserResult = await executeQuery('SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)', [userId]);
    
    if (!checkUserResult.success) {
        throw new ValidationError('Error when validating user');
    }
    
    if (!checkUserResult.data[0].exists) {
        throw new ValidationError(`User id is not valid: ${userId}`);
    }
}

/**
 * Gets project information based on action type
 * @param {string} action - Action type (job, report, etc.)
 * @param {string} jobId - Job ID if action is job
 * @param {string} reportId - Report ID if action is report
 * @returns {Object} Object containing projectId and subPath
 * @throws {ValidationError} If validation fails
 * @throws {ResourceNotFoundError} If resource not found
 */
async function getProjectInfo(action, jobId, reportId) {
    if (actionEnum[action] === actionEnum['job']) {
        const selectJobResult = await executeQuery('SELECT project_id FROM jobs WHERE id = $1', [jobId]);
        
        if (!selectJobResult.success) {
            throw new ValidationError('Error when validating job');
        }
        
        if (!selectJobResult.data || !selectJobResult.data[0]) {
            throw new ResourceNotFoundError('Job ID not found in database');
        }
        
        return {
            projectId: selectJobResult.data[0].project_id,
            subPath: jobId
        };
    } 
    else if (actionEnum[action] === actionEnum['report']) {
        const selectReportResult = await executeQuery(
            'SELECT project_id FROM reports WHERE id = $1 AND type = $2', 
            [reportId, reportType['REPORT']]
        );
        
        if (!selectReportResult.success) {
            throw new ValidationError('Error when validating report');
        }
        
        if (!selectReportResult.data || !selectReportResult.data[0]) {
            throw new ResourceNotFoundError('Report ID not found in database');
        }
        
        return {
            projectId: selectReportResult.data[0].project_id,
            subPath: reportId
        };
    }
    
    throw new ValidationError('Invalid action type for image');
}

/**
 * Ensures the compress folder exists, creates if not
 * @param {string} compressPath - Compress folder path
 */
async function ensureCompressFolderExists(compressPath) {
    try {
        const listCommand = new ListObjectsV2Command({
            Bucket: DESTINATION_BUCKET,
            Prefix: compressPath + '/',
            MaxKeys: 1
        });

        const listResult = await s3.send(listCommand);
        
        // If folder doesn't exist, create it with a placeholder
        if (!listResult.Contents || listResult.Contents.length === 0) {
            console.log(`Creating compress folder: ${compressPath}`);
            
            await s3.send(new PutObjectCommand({
                Bucket: DESTINATION_BUCKET,
                Key: `${compressPath}/.gitkeep`,
                Body: '',
                ContentType: 'text/plain',
                Metadata: {
                    purpose: 'folder_placeholder',
                    created_at: new Date().toISOString()
                }
            }));
            
            console.log(`Compress folder created: ${compressPath}`);
        } else {
            console.log(`Compress folder already exists: ${compressPath}`);
        }
        
    } catch (error) {
        console.error(`Error checking/creating compress folder ${compressPath}:`, error);
        // Don't throw - folder will be created when we upload the file
    }
}

/**
 * Checks if a folder exists in S3
 * @param {string} folder - Folder path to check
 * @param {string} bucketName - S3 bucket name
 * @returns {boolean} True if folder exists
 */
async function isFolderExisted(folder, bucketName) {
    try {
        console.log(`Checking if folder ${folder} exists in bucket ${bucketName}`);

        // Use ListObjectsV2 instead of HeadObject
        const listCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: folder,
            MaxKeys: 1
        });

        const listResult = await s3.send(listCommand);
        
        // If Contents array exists and has items, the folder exists
        const folderExists = listResult.Contents && listResult.Contents.length > 0;
        console.log(`Folder ${folder} exists: ${folderExists}`);

        return folderExists;
    } catch (error) {
        if (error.name === 'AccessDenied') {
            console.error(`Access denied checking folder ${folder}. Check IAM permissions for s3:ListBucket on ${bucketName}`);
            throw new ResourceNotFoundError(`Access denied for folder ${folder}`);
        } else {
            console.error(`Error checking if folder ${folder} exists:`, error);
            return false;
        }
    }
}