import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
//import { Agent } from "https";
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
const compressFolder = 'compress';
const attachmentsSubfolder = 'attachments';
const draftFolder = 'attachments_draft';

// Supported file types
const SUPPORTED_DOCUMENTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx'];
const SUPPORTED_IMAGES = ['jpg', 'jpeg', 'png', 'webp'];

// Action enum with proper typing
const actionEnum: { [key: string]: number } = { 'quotation': 0, 'job': 1, 'report': 2 };
const reportType = Object.freeze({
    TEMPLATE: 0,
    HEADER: 1,
    FOOTER: 2,
    REPORT: 3,
    COVER: 4
});

// File type mapping with proper typing
const FILE_TYPE_MAP: { [key: string]: string } = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.PDF': 'application/pdf',
  '.DOC': 'application/msword',
  '.DOCX': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.XLS': 'application/vnd.ms-excel',
  '.XLSX': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.JPG': 'image/jpeg',
  '.JPEG': 'image/jpeg',
  '.PNG': 'image/png',
  '.WEBP': 'image/webp'
};

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
  draftLocation?: string;
  processResult?: any;
  searchedLocations?: string[];
  s3Location?: {
    bucket: string;
    key: string;
    region: string;
  };
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

export const handler: Handler = async (event: any): Promise<APIGatewayProxyResult> => {
  console.log('Attachment processor received event:', JSON.stringify(event, null, 2));

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

    // Check if file exists in destination
    const attachmentPath = `${compressFolder}/${requestData.projectId}/${subPath}/${attachmentsSubfolder}`;
    const destinationKey = `${attachmentPath}/${requestData.fileName}`;
    
    //const fileExists = await checkFileExists(DESTINATION_BUCKET!, destinationKey);
    
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

    //   const successResponse = new ApiResponse(true, responseData, 'File already exists in destination');
    //   return LambdaResponse.success(successResponse, 200);
    // } else {
      // File doesn't exist, check if it exists in draft folder and trigger processing
    const draftKey = `${draftFolder}/${requestData.fileName}`;
    const draftFileExists = await checkFileExists(SOURCE_BUCKET!, draftKey);
    
    if (draftFileExists) {
      // File exists in draft, trigger processing by simulating S3 event
      const simulatedS3Event = {
        Records: [{
          s3: {
            bucket: { name: SOURCE_BUCKET },
            object: { key: draftKey }
          }
        }]
      };
      
      console.log(`Triggering processing for file: ${draftKey}`);
      const processResult = await handleS3Event(simulatedS3Event);
      
      const responseData: CheckProcessResponse = {
        fileName: requestData.fileName,
        exists: false,
        triggerProcessing: true,
        draftLocation: draftKey,
        processResult: processResult
      };

      const successResponse = new ApiResponse(true, responseData, 'File found in draft folder and processing triggered');
      return LambdaResponse.success(successResponse, 200);
    } else {
      // File doesn't exist in either location
      const responseData: CheckProcessResponse = {
        fileName: requestData.fileName,
        exists: false,
        searchedLocations: [
          destinationKey,
          draftKey
        ]
      };

      const errorResponse = new ApiResponse(false, responseData, 'File not found in destination or draft folder');
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
 * Handle S3 events (existing logic)
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

    const isImageFile = SUPPORTED_IMAGES.includes(fileExtension.substring(1).toLowerCase());

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

    // Create destination path
    const attachmentPath = `${compressFolder}/${projectId}/${subPath}/${attachmentsSubfolder}`;
    const destinationKey = `${attachmentPath}/${fileName}`;

    // Ensure attachments subfolder exists
    await ensureAttachmentsSubfolderExists(attachmentPath);

    // Read file content
    const fileBuffer = await Body!.transformToByteArray();
    const finalFileSize = ContentLength || 0;

    // Insert attachment record
    const attachmentRecord = {
      job_id: actionEnum[action] === actionEnum['job'] ? job_id : null,
      file_url: destinationKey,
      original_filename: fileName,
      file_type: FILE_TYPE_MAP[fileExtension] || 'application/octet-stream',
      file_extension: fileExtension,
      file_size: finalFileSize,
      upload_status: 'ACTIVE',
      created_by: user_id,
      modified_by: user_id,
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString(),
    };

    const insertResult = await insertRecord('job_attachments', attachmentRecord);
    
    if (!insertResult.success) {
      const errorMessage = 'error' in insertResult ? insertResult.error : 'Unknown error';
      console.error(`Failed to insert attachment record: ${errorMessage}`);
      return { 
        statusCode: 500, 
        body: `Failed to save attachment record: ${errorMessage}` 
      };
    }

    const attachmentId = 'data' in insertResult ? insertResult.data?.[0]?.id : undefined;
    console.log(`Attachment record inserted successfully: ${fileName}, ID: ${attachmentId}`);

    // Upload file to attachments subfolder
    await s3.send(new PutObjectCommand({
      Bucket: DESTINATION_BUCKET!,
      Key: destinationKey,
      Body: fileBuffer,
      ContentType: ContentType || FILE_TYPE_MAP[fileExtension] || 'application/octet-stream',
      Metadata: {
        ...Metadata,
        processed: 'true',
        attachment_id: attachmentId || 'unknown',
        file_size: finalFileSize.toString(),
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

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: `${isImageFile ? 'Image' : 'Document'} attachment processed and saved successfully`,
        data: {
          attachmentId: attachmentId,
          fileName: fileName,
          fileUrl: `https://${DESTINATION_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${destinationKey}`,
          fileType: FILE_TYPE_MAP[fileExtension] || 'application/octet-stream',
          fileSize: finalFileSize,
          projectId: projectId,
          jobId: actionEnum[action] === actionEnum['job'] ? job_id : null,
          reportId: actionEnum[action] === actionEnum['report'] ? report_id : null,
          uploadStatus: 'ACTIVE',
          processingStatus: 'COMPLETED'
        }
      })
    };

  } catch (error) {
    console.error('Error processing attachment:', error);
    
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
  
  throw new ValidationError('Invalid action type');
}

/**
 * Ensures the attachments subfolder exists
 */
async function ensureAttachmentsSubfolderExists(attachmentPath: string) {
  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: DESTINATION_BUCKET!,
      Prefix: attachmentPath + '/',
      MaxKeys: 1
    });

    const listResult = await s3.send(listCommand);
    
    if (!listResult.Contents || listResult.Contents.length === 0) {
      console.log(`Creating attachments subfolder: ${attachmentPath}`);
      
      await s3.send(new PutObjectCommand({
        Bucket: DESTINATION_BUCKET!,
        Key: `${attachmentPath}/.gitkeep`,
        Body: '',
        ContentType: 'text/plain',
        Metadata: {
          purpose: 'folder_placeholder',
          created_at: new Date().toISOString()
        }
      }));
      
      console.log(`Attachments subfolder created: ${attachmentPath}`);
    }
    
  } catch (error) {
    console.error(`Error checking/creating attachments subfolder ${attachmentPath}:`, error);
  }
}