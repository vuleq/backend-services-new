import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { executeQuery, insertRecord } from 'wdr-connect-db';
import { isValidUUID, isValidCognitoSub } from 'wdr-common-utils';
import sharp from 'sharp';

// Custom error classes
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

// Folder structure
const compressFolder = 'compress';
const attachmentsSubfolder = 'attachments';

// Supported file types
const SUPPORTED_DOCUMENTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx'];
const SUPPORTED_IMAGES = ['jpg', 'jpeg', 'png', 'webp'];

// Action enum
const actionEnum = { 'quotation': 0, 'job': 1, 'report': 2 };
const reportType = Object.freeze({
    TEMPLATE: 0,
    HEADER: 1,
    FOOTER: 2,
    REPORT: 3,
    COVER: 4
});

// File type mapping - supports both lowercase and uppercase extensions
const FILE_TYPE_MAP = {
  // Documents - lowercase
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  
  // Documents - uppercase
  '.PDF': 'application/pdf',
  '.DOC': 'application/msword',
  '.DOCX': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.XLS': 'application/vnd.ms-excel',
  '.XLSX': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  
  // Images - lowercase
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  
  // Images - uppercase
  '.JPG': 'image/jpeg',
  '.JPEG': 'image/jpeg',
  '.PNG': 'image/png',
  '.WEBP': 'image/webp'
};

export const handler = async (event) => {
  console.log('Attachment processor received event:', JSON.stringify(event, null, 2));

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
    const fileExtension = '.' + srcKey.split('.').pop();

    console.log(`Processing file: ${srcKey}, extension: ${fileExtension}`);

    // Check if file is in attachments_draft folder only
    if (!srcKey.startsWith('attachments_draft/')) {
      console.log('Not in attachments_draft folder, skipping processing');
      return { statusCode: 200, body: 'Skipped - not in attachments_draft folder' };
    }

    // Check if supported file type
    if (!FILE_TYPE_MAP[fileExtension]) {
      console.log(`Unsupported file type: ${fileExtension}, skipping processing`);
      return { statusCode: 200, body: 'Skipped - unsupported file format' };
    }

    // Get file from S3
    const { Body, ContentType, Metadata, ContentLength } = await s3.send(new GetObjectCommand({
      Bucket: srcBucket,
      Key: srcKey
    }));

    // Check if already processed
    if (Metadata?.processed === 'true') {
      console.log('File already processed, skipping');
      return { statusCode: 200, body: 'Skipped - already processed' };
    }

    // All files in attachments_draft are treated as attachments
    const isAttachment = true;
    const isImageFile = SUPPORTED_IMAGES.includes(fileExtension.substring(1).toLowerCase());

    const { action, user_id, job_id, report_id } = Metadata;
    
    // Validate metadata
    try {
      validateMetadata(action, user_id, job_id, report_id);
    } catch (error) {
      console.error(`Metadata validation error: ${error.message}`);
      return { statusCode: 200, body: `Skipped - ${error.message}` };
    }

    // Validate user exists
    try {
      await validateUserExists(user_id);
    } catch (error) {
      console.error(`User validation error: ${error.message}`);
      return { statusCode: 200, body: `Skipped - ${error.message}` };
    }

    // Get project info
    let projectId, subPath;
    try {
      const result = await getProjectInfo(action, job_id, report_id);
      projectId = result.projectId;
      subPath = result.subPath;
    } catch (error) {
      console.error(`Project info error: ${error.message}`);
      return { statusCode: 200, body: `Skipped - ${error.message}` };
    }

    // Extract filename
    const pathParts = srcKey.split('/');
    const fileName = pathParts[pathParts.length - 1];

    // Create destination path: compress/{projectId}/{jobId}/attachments/
    const attachmentPath = `${compressFolder}/${projectId}/${subPath}/${attachmentsSubfolder}`;
    const destinationKey = `${attachmentPath}/${fileName}`;

    // Ensure attachments subfolder exists
    await ensureAttachmentsSubfolderExists(attachmentPath);

    // Read file content
    const fileBuffer = await Body.transformToByteArray();
    
    // For images, apply light compression
    let processedBuffer = fileBuffer;
    let finalFileSize = ContentLength;
    
    if (isImageFile) {
      console.log('Processing image as attachment - applying light compression');
      try {
        processedBuffer = await compressImageAttachment(fileBuffer, fileExtension);
        finalFileSize = processedBuffer.length;
      } catch (error) {
        console.error('Error compressing image, using original:', error);
        processedBuffer = fileBuffer;
        finalFileSize = ContentLength;
      }
    }

    // Generate file URL
    const fileUrl = `https://${DESTINATION_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${destinationKey}`;

    // Insert attachment record
    const attachmentRecord = {
      job_id: actionEnum[action] === actionEnum['job'] ? job_id : null,
      file_url: destinationKey,
      original_filename: fileName,
      file_type: FILE_TYPE_MAP[fileExtension],
      file_extension: fileExtension,
      file_size: finalFileSize,
      upload_status: 'ACTIVE',
      created_by: user_id,
      modified_by: user_id,
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString(), // Sửa từ updated_at thành modified_at
    };

    // Insert attachment record
    const insertResult = await insertRecord('job_attachments', attachmentRecord);
    
    if (!insertResult.success) {
      console.error(`Failed to insert attachment record: ${insertResult.error}`);
      return { 
        statusCode: 500, 
        body: `Failed to save attachment record: ${insertResult.error}` 
      };
    }

    const attachmentId = insertResult.data?.[0]?.id;
    console.log(`Attachment record inserted successfully: ${fileName}, ID: ${attachmentId}`);

    // Upload file to attachments subfolder
    await s3.send(new PutObjectCommand({
      Bucket: DESTINATION_BUCKET,
      Key: destinationKey,
      Body: processedBuffer,
      ContentType: ContentType || FILE_TYPE_MAP[fileExtension] || 'application/octet-stream',
      Metadata: {
        ...Metadata,
        processed: 'true',
        attachment_id: attachmentId || 'unknown',
        original_size: ContentLength?.toString(),
        processed_size: finalFileSize?.toString(),
        project_id: projectId,
        processing_timestamp: new Date().toISOString(),
        processor_version: '3.0',
        source_folder: 'attachments_draft'
      }
    }));

    console.log(`File saved to compress/attachments: ${destinationKey}`);

    // Delete original file
    await s3.send(new DeleteObjectCommand({
      Bucket: srcBucket,
      Key: srcKey
    }));

    console.log(`Deleted original file: ${srcKey}`);

    // Response data
    const responseData = {
      attachmentId: attachmentId,
      fileName: fileName,
      fileUrl: fileUrl,
      fileType: FILE_TYPE_MAP[fileExtension],
      fileSize: finalFileSize,
      originalFileSize: ContentLength,
      projectId: projectId,
      jobId: actionEnum[action] === actionEnum['job'] ? job_id : null,
      reportId: actionEnum[action] === actionEnum['report'] ? report_id : null,
      uploadStatus: 'ACTIVE',
      processingStatus: 'COMPLETED',
      isImageAttachment: isImageFile,
      compressed: isImageFile,
      sourceFolder: 'attachments_draft',
      s3Location: {
        bucket: DESTINATION_BUCKET,
        key: destinationKey,
        region: process.env.AWS_REGION
      },
      processingDetails: {
        compressionApplied: isImageFile,
        compressionRatio: isImageFile ? (1 - (finalFileSize / ContentLength)) : 0,
        processingTime: new Date().toISOString()
      }
    };

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: `${isImageFile ? 'Image' : 'Document'} attachment processed and saved successfully (no compression applied)`,
        data: responseData,
        sourceInfo: {
          folder: 'attachments_draft',
          treatedAsAttachment: true
        }
      })
    };

  } catch (error) {
    console.error('Error processing attachment:', error);
    
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
      throw error; // Let Lambda handle retry
    }
  }
};

/**
 * Validates metadata fields
 */
function validateMetadata(action, userId, jobId, reportId) {
  if (!action || !userId) {
    throw new ValidationError('missing required metadata: user_id, action');
  }
  
  if (!actionEnum.hasOwnProperty(action)) {
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
 * Validates user exists in database
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
  
  throw new ValidationError('Invalid action type');
}

/**
 * Ensures the attachments subfolder exists
 */
async function ensureAttachmentsSubfolderExists(attachmentPath) {
  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: DESTINATION_BUCKET,
      Prefix: attachmentPath + '/',
      MaxKeys: 1
    });

    const listResult = await s3.send(listCommand);
    
    if (!listResult.Contents || listResult.Contents.length === 0) {
      console.log(`Creating attachments subfolder: ${attachmentPath}`);
      
      await s3.send(new PutObjectCommand({
        Bucket: DESTINATION_BUCKET,
        Key: `${attachmentPath}/.gitkeep`,
        Body: '',
        ContentType: 'text/plain',
        Metadata: {
          purpose: 'folder_placeholder',
          created_at: new Date().toISOString()
        }
      }));
      
      console.log(`Attachments subfolder created: ${attachmentPath}`);
    } else {
      console.log(`Attachments subfolder already exists: ${attachmentPath}`);
    }
    
  } catch (error) {
    console.error(`Error checking/creating attachments subfolder ${attachmentPath}:`, error);
  }
}

/**
 * Light compression for image attachments
 */
async function compressImageAttachment(imageBuffer, fileExtension) {
  try {
    const ext = fileExtension.toLowerCase();
    
    switch (ext) {
      case '.webp':
        return await sharp(imageBuffer)
          .webp({ quality: 80, lossless: false })
          .toBuffer();
      case '.jpeg':
      case '.jpg':
        return await sharp(imageBuffer)
          .jpeg({ quality: 80, progressive: true })
          .toBuffer();
      case '.png':
        return await sharp(imageBuffer)
          .png({ compressionLevel: 6 })
          .toBuffer();
      default:
        return imageBuffer;
    }
  } catch (error) {
    console.error('Error compressing image attachment:', error);
    return imageBuffer;
  }
}