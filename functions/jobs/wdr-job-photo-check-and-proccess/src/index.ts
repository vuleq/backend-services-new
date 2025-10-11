import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { executeQuery, insertRecord } from 'wdr-connect-db';
import { isValidUUID, isValidCognitoSub } from 'wdr-common-utils';
import { ApiResponse, LambdaResponse } from 'wdr-models';

// Custom error classes
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

// const httpsAgent = new Agent({
//   keepAlive: false,
//   maxSockets: 50,
//   timeout: 60000,
// });

const s3 = new S3Client({
  region: process.env.AWS_REGION
  // ,
  // requestHandler: {
  //   httpsAgent: httpsAgent
  // }
  // Dùng default maxAttempts (3)
});

const DESTINATION_BUCKET = process.env.DESTINATION_BUCKET;
const SOURCE_BUCKET = DESTINATION_BUCKET;

const defaultUserId = "00000000-0000-0000-0000-000000000000";
const defaultUserName = 'PaxOcean Admin';

// Folder structure
const originalsFolder = 'originals';
const compressFolder = 'compress';

// Supported formats
const SUPPORTED_FORMATS = ['webp', 'jpeg', 'png', 'jpg'];

// Action enum with proper typing
const actionEnum: { [key: string]: number } = { 'quotation': 0, 'job': 1, 'report': 2 };

const reportType = Object.freeze({
    TEMPLATE: 0,
    HEADER: 1,
    FOOTER: 2,
    REPORT: 3,
    COVER: 4
});

// Global settings - removed compression settings
const MaxUploadImageSize = 'MAX_UPLOAD_IMAGE_SIZE';

let globalSettingsCache: { maxSize: number } | null = null;
let cacheTimestamp: number | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Interfaces
interface CheckProcessRequest {
  projectId: string;
  jobId?: string;
  reportId?: string;
  fileName: string;
  action: string;
  userId?: string;
}

interface CheckProcessResponse {
  fileName: string;
  fileUrl?: string;
  exists: boolean;
  fileSize?: number;
  lastModified?: string;
  triggerProcessing?: boolean;
  originalLocation?: string;
  processResult?: any;
  searchedLocations?: string[];
  s3Location?: {
    bucket: string;
    key: string;
    region: string;
  };
}

interface GlobalSettings {
  maxSize: number;
}

function getLoginUserInfo(requestHeader: APIGatewayProxyEventHeaders | undefined) {
  let userId = defaultUserId;
  let userName = defaultUserName;

  if (requestHeader) {
    let token = requestHeader["Authorization"] || requestHeader["authorization"];
    if (token) {
      token = token.replace('Bearer ', '');
      const payload = parseJWT(token);
      console.log('JWT token processed successfully');
      userId = payload?.sub;
      userName = payload?.name;
    }
  }
  return { userId, userName };
}

function parseJWT(token: string) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    const payload = parts[1];
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (error) {
    console.error('JWT parse error occurred');
    return null;
  }
}

async function getGlobalSettings(): Promise<GlobalSettings> {
    const now = Date.now();

    if (globalSettingsCache && cacheTimestamp && (now - cacheTimestamp) < CACHE_TTL) {
        return globalSettingsCache;
    }

    const selectSql = 'SELECT value, code FROM app_settings WHERE code = $1';
    const settings = await executeQuery(selectSql, [MaxUploadImageSize]);

    if (settings.success && settings.data && settings.data.length > 0) {
        globalSettingsCache = {
            maxSize: Number(settings.data[0].value) || 20
        };
        cacheTimestamp = now;
        return globalSettingsCache;
    }

    // Return defaults if DB query fails
    return { maxSize: 20 };
}

export const handler: Handler = async (event: any): Promise<APIGatewayProxyResult> => {
  console.log('Image processor received event:', JSON.stringify(event, null, 2));

  if (!DESTINATION_BUCKET) {
    console.error('DESTINATION_BUCKET environment variable is not set.');
    const errorResponse = new ApiResponse(false, undefined, 'Configuration error: Destination bucket not set');
    return LambdaResponse.error(errorResponse, 500);
  }

  // Check if this is an API Gateway event
  if (event.httpMethod) {
    return await handleApiRequest(event as APIGatewayProxyEvent);
  }

  // Handle S3 event (existing logic)
  return await handleS3Event(event);
};

/**
 * Handle API Gateway requests
 */
async function handleApiRequest(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    console.log('Processing API request:', JSON.stringify(event, null, 2));

    // Parse request data
    const requestData = parseRequestData(event);
    console.log('Parsed request data:', requestData);

    // Get user info from JWT token
    const userInfo = getLoginUserInfo(event.headers);
    console.log('User info:', userInfo);

    // Validate required parameters
    if (!requestData.projectId || !requestData.fileName || !requestData.action) {
      const errorResponse = new ApiResponse(false, undefined, 'Missing required parameters: projectId, fileName, action');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate projectId format
    if (!isValidUUID(requestData.projectId)) {
      const errorResponse = new ApiResponse(false, undefined, 'Invalid projectId format');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Check if file is a supported image format
    const fileExtension = requestData.fileName.split('.').pop()?.toLowerCase();
    if (!fileExtension || !SUPPORTED_FORMATS.includes(fileExtension)) {
      const errorResponse = new ApiResponse(false, undefined, `Unsupported image format. Supported formats: ${SUPPORTED_FORMATS.join(', ')}`);
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate action and get subPath
    let subPath: string;
    if (requestData.action === 'job') {
      if (!requestData.jobId || !isValidUUID(requestData.jobId)) {
        const errorResponse = new ApiResponse(false, undefined, 'jobId is required and must be valid UUID for job action');
        return LambdaResponse.error(errorResponse, 400);
      }
      subPath = requestData.jobId;
    } else if (requestData.action === 'report') {
      if (!requestData.reportId || !isValidUUID(requestData.reportId)) {
        const errorResponse = new ApiResponse(false, undefined, 'reportId is required and must be valid UUID for report action');
        return LambdaResponse.error(errorResponse, 400);
      }
      subPath = requestData.reportId;
    } else {
      const errorResponse = new ApiResponse(false, undefined, 'Invalid action. Must be job or report');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Check if compressed file exists in destination
    const compressPath = `${compressFolder}/${requestData.projectId}/${subPath}`;
    const destinationKey = `${compressPath}/${requestData.fileName}`;
    
    // const fileExists = await checkFileExists(DESTINATION_BUCKET!, destinationKey);
    
    // if (fileExists) {
    //   // File already exists, return file info
    //   const fileInfo = await getFileInfo(DESTINATION_BUCKET!, destinationKey);
      
    //   const responseData: CheckProcessResponse = {
    //     fileName: requestData.fileName,
    //     fileUrl: `https://${DESTINATION_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${destinationKey}`,
    //     exists: true,
    //     fileSize: fileInfo?.ContentLength || 0,
    //     lastModified: fileInfo?.LastModified?.toISOString() || undefined,
    //     s3Location: {
    //       bucket: DESTINATION_BUCKET!,
    //       key: destinationKey,
    //       region: process.env.AWS_REGION!
    //     }
    //   };

    //   const successResponse = new ApiResponse(true, responseData, 'Image already exists in destination');
    //   return LambdaResponse.success(successResponse, 200);
    // } else {
      // File doesn't exist, check if it exists in originals folder and trigger processing
    const originalKey = `${originalsFolder}/${requestData.fileName}`;
    const originalFileExists = await checkFileExists(SOURCE_BUCKET!, originalKey);
    
    if (originalFileExists) {
      // File exists in originals, trigger processing by simulating S3 event
      const simulatedS3Event = {
        Records: [{
          s3: {
            bucket: { name: SOURCE_BUCKET },
            object: { key: originalKey }
          }
        }]
      };
      
      console.log(`Triggering processing for image: ${originalKey}`);
      const processResult = await handleS3Event(simulatedS3Event);
      
      const responseData: CheckProcessResponse = {
        fileName: requestData.fileName,
        exists: false,
        triggerProcessing: true,
        originalLocation: originalKey,
        processResult: processResult
      };

      const successResponse = new ApiResponse(true, responseData, 'Image found in originals folder and processing triggered');
      return LambdaResponse.success(successResponse, 200);
    } else {
      // File doesn't exist in either location
      const responseData: CheckProcessResponse = {
        fileName: requestData.fileName,
        exists: false,
        searchedLocations: [
          destinationKey,
          originalKey
        ]
      };

      const errorResponse = new ApiResponse(false, responseData, 'Image not found in destination or originals folder');
      return LambdaResponse.error(errorResponse, 404);
    }
    //}

  } catch (error: unknown) {
    console.error('API request error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    const errorResponse = new ApiResponse(false, undefined, errorMessage);
    return LambdaResponse.error(errorResponse, 500);
  }
}

function parseRequestData(event: APIGatewayProxyEvent): CheckProcessRequest {
  let requestData: CheckProcessRequest;

  try {
    if (event.body) {
      requestData = JSON.parse(event.body);
    } else {
      // Fallback to query parameters
      const queryParams = event.queryStringParameters || {};
      requestData = {
        projectId: queryParams.projectId || '',
        jobId: queryParams.jobId,
        reportId: queryParams.reportId,
        fileName: queryParams.fileName || '',
        action: queryParams.action || ''
      };
    }
  } catch (error) {
    console.error('Error parsing request data:', error);
    requestData = {
      projectId: '',
      fileName: '',
      action: ''
    };
  }

  return requestData;
}

/**
 * Handle S3 events (image processing logic - no compression)
 */
async function handleS3Event(event: any) {
  if (!event.Records?.[0]) {
    console.error('No S3 record found in event');
    return { statusCode: 400, body: 'Invalid event format' };
  }

  try {
    const record = event.Records[0];
    const srcBucket = record.s3.bucket.name;
    const srcKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const imageType = srcKey.split('.').pop()?.toLowerCase();

    console.log(`Processing image: ${srcKey}, type: ${imageType}`);

    // Skip if not in originals folder to prevent recursive triggers
    if (!srcKey.startsWith(`${originalsFolder}/`)) {
      console.log('Not an original image, skipping processing');
      return { statusCode: 200, body: 'Skipped - not in originals folder' };
    }

    if (!imageType || !SUPPORTED_FORMATS.includes(imageType)) {
      console.log(`Unsupported image type: ${imageType}, skipping processing`);
      return { statusCode: 200, body: 'Skipped - unsupported format' };
    }

    // Get image from S3
    const { Body, ContentType, Metadata, ContentLength } = await s3.send(new GetObjectCommand({
      Bucket: srcBucket,
      Key: srcKey
    }));

    if (Metadata?.processed === 'true') {
      console.log('Image already processed, skipping');
      return { statusCode: 200, body: 'Skipped - already processed' };
    }

    const { action, user_id, job_id, report_id } = Metadata || {};

    // Validate metadata
    try {
      validateMetadata(action, user_id, job_id, report_id);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Metadata validation failed';
      console.error(`Metadata validation error: ${errorMessage}`);
      return { statusCode: 200, body: `Skipped - ${errorMessage}` };
    }

    // Validate user exists
    try {
      await validateUserExists(user_id);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'User validation failed';
      console.error(`User validation error: ${errorMessage}`);
      return { statusCode: 200, body: `Skipped - ${errorMessage}` };
    }

    // Get project info
    let projectId: string, subPath: string;
    try {
      const result = await getProjectInfo(action, job_id, report_id);
      projectId = result.projectId;
      subPath = result.subPath;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Project info error';
      console.error(`Project info error: ${errorMessage}`);
      return { statusCode: 200, body: `Skipped - ${errorMessage}` };
    }

    // Extract filename
    const pathParts = srcKey.split('/');
    const fileName = pathParts[pathParts.length - 1];

    // Check compress folder exists - using the same pattern as attachment
    const compressFileFolder = `${compressFolder}/${projectId}/${subPath}`;
    await ensureCompressFolderExists(compressFileFolder);

    const imageBuffer = await Body!.transformToByteArray();
    const finalFileSize = ContentLength || imageBuffer.length;

    // Get global settings for file size validation
    const { maxSize } = await getGlobalSettings();
    console.log(`Using max file size limit: ${maxSize}MB`);

    // Check file size against maxSize limit (in MB)
    const fileSizeInMB = imageBuffer.length / (1024 * 1024);
    if (maxSize && fileSizeInMB > maxSize) {
      console.log(`File size ${fileSizeInMB.toFixed(2)}MB exceeds limit ${maxSize}MB, skipping processing`);
      return { statusCode: 200, body: `Skipped - file size ${fileSizeInMB.toFixed(2)}MB exceeds ${maxSize}MB limit` };
    }

    const compressFileKey = `${compressFileFolder}/${fileName}`;

    // Insert file record
    const insertFileResult = await insertRecord('files', {
      s3_url: compressFileKey,
      file_name: fileName,
      file_type: imageType,
      file_size_bytes: finalFileSize,
      uploaded_by: user_id,
      uploaded_at: new Date().toISOString(),
      project_id: projectId,
      job_id: actionEnum[action] === actionEnum['job'] ? subPath : null,
      report_id: actionEnum[action] === actionEnum['report'] ? subPath : null
    });

    if (!insertFileResult.success) {
      const errorMessage = 'error' in insertFileResult ? insertFileResult.error : 'Unknown error';
      console.error(`Failed to insert file record: ${errorMessage}`);
      return { 
        statusCode: 500, 
        body: `Failed to save file record: ${errorMessage}` 
      };
    }

    const fileId = 'data' in insertFileResult ? insertFileResult.data?.[0]?.id : undefined;
    console.log(`File record inserted successfully: ${fileName}, ID: ${fileId}`);

    // Upload original image to compress folder (no compression applied)
    await s3.send(new PutObjectCommand({
      Bucket: DESTINATION_BUCKET!,
      Key: compressFileKey,
      Body: imageBuffer,
      ContentType: ContentType || (imageType === 'jpg' ? 'image/jpeg' : `image/${imageType}`),
      Metadata: {
        ...Metadata,
        processed: 'true',
        file_id: fileId || 'unknown',
        file_size: finalFileSize.toString(),
        project_id: projectId,
        processing_timestamp: new Date().toISOString(),
        processor_version: '3.0',
        source_folder: 'originals'
      }
    }));

    console.log(`Saved image file: ${compressFileKey}`);

    // Delete original file
    await s3.send(new DeleteObjectCommand({
      Bucket: srcBucket,
      Key: srcKey
    }));

    console.log(`Deleted original file: ${srcKey}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Image processed and saved successfully',
        data: {
          fileId: fileId,
          fileName: fileName,
          fileUrl: `https://${DESTINATION_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${compressFileKey}`,
          fileType: imageType,
          fileSize: finalFileSize,
          s3Url: compressFileKey,
          projectId: projectId,
          jobId: actionEnum[action] === actionEnum['job'] ? subPath : null,
          reportId: actionEnum[action] === actionEnum['report'] ? subPath : null,
          processingStatus: 'COMPLETED'
        }
      })
    };

  } catch (error: unknown) {
    console.error('Error processing S3 event:', error);
    
    if (error instanceof ValidationError) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: error.message })
      };
    } else if (error instanceof ResourceNotFoundError) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: error.message })
      };
    } else {
      throw error;
    }
  }
}

/**
 * Check if file exists in S3 bucket
 */
async function checkFileExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }));
    return true;
  } catch (error: any) {
    if (error.name === 'NoSuchKey') {
      return false;
    }
    throw error;
  }
}

/**
 * Get file information from S3
 */
async function getFileInfo(bucket: string, key: string) {
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }));
    return {
      ContentLength: response.ContentLength,
      LastModified: response.LastModified,
      ContentType: response.ContentType,
      Metadata: response.Metadata
    };
  } catch (error) {
    console.error('Error getting file info:', error);
    return null;
  }
}

/**
 * Validates metadata fields
 */
function validateMetadata(action: string, userId: string, jobId: string, reportId: string) {
  if (!action || !userId) {
    throw new ValidationError('missing required metadata: user_id, action');
  }
  
  if (!(action in actionEnum)) {
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
async function validateUserExists(userId: string) {
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
async function getProjectInfo(action: string, jobId: string, reportId: string) {
  if (actionEnum[action] === actionEnum['job']) {
    const selectJobResult = await executeQuery('SELECT project_id FROM jobs WHERE id = $1', [jobId]);
    
    if (!selectJobResult.success) {
      throw new ValidationError('Error when validating job');
    }
    
    if (!selectJobResult.data || !selectJobResult.data.length) {
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
    
    if (!selectReportResult.data || !selectReportResult.data.length) {
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
 * Ensures the compress folder exists - similar to attachment's ensureAttachmentsSubfolderExists
 */
async function ensureCompressFolderExists(compressPath: string) {
  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: DESTINATION_BUCKET!,
      Prefix: compressPath + '/',
      MaxKeys: 1
    });

    const listResult = await s3.send(listCommand);
    
    if (!listResult.Contents || listResult.Contents.length === 0) {
      console.log(`Creating compress folder: ${compressPath}`);
      
      await s3.send(new PutObjectCommand({
        Bucket: DESTINATION_BUCKET!,
        Key: `${compressPath}/.gitkeep`,
        Body: '',
        ContentType: 'text/plain',
        Metadata: {
          purpose: 'folder_placeholder',
          created_at: new Date().toISOString()
        }
      }));
      
      console.log(`Compress folder created: ${compressPath}`);
    }
    
  } catch (error) {
    console.error(`Error checking/creating compress folder ${compressPath}:`, error);
  }
}