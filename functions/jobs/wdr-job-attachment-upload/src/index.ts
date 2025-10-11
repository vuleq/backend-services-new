import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { executeQuery, performTransaction, Operation } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

const defaultUserId = "00000000-0000-0000-0000-000000000000";
const defaultUserName = 'PaxOcean Admin';
const headOfDepartmentCode = 'HOD';

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

// Interfaces
interface SaveFileUrlsRequest {
  jobId: string;
  files: FileUrlData[];
  userId?: string;
}

interface FileUrlData {
  fileUrl: string;
  originalFilename: string;
  fileType?: string;
  fileSize?: number;
}

interface FileUploadConfig {
  maxFilesPerJob: number;
  supportedFileTypes: string[];
  supportedFileExtensions: string[];
}

interface SaveResult {
  id: string;
  fileUrl: string;
  originalFilename: string;
  fileType: string;
  fileSize?: number;
  status: 'SUCCESS' | 'FAILED';
  error?: string;
}

interface SaveFileUrlsResponse {
  totalFiles: number;
  successfulSaves: number;
  failedSaves: number;
  results: SaveResult[];
  replacedExisting: boolean;
  deletedCount: number;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Save file URLs event:', JSON.stringify(event, null, 2));

    // Parse request data
    const requestData = parseRequestData(event);
    console.log('Parsed request data:', { jobId: requestData.jobId, filesCount: requestData.files.length });

    // Get user info
    const userInfo = getUserInfo(event.headers, requestData.userId);
    console.log('User info:', userInfo);

    // Validate required fields
    if (!requestData.jobId) {
      const errorResponse = new ApiResponse(false, undefined, 'Missing required field: jobId');
      return LambdaResponse.error(errorResponse, 400);
    }

    if (!requestData.files || requestData.files.length === 0) {
      requestData.files = [];
    }

    // Get upload configuration
    const config = await getUploadConfig();
    if (!config) {
      const errorResponse = new ApiResponse(false, undefined, 'Failed to load upload configuration');
      return LambdaResponse.error(errorResponse, 500);
    }

    // Validate job and check if replacement is needed
    const currentFileCount = await getCurrentFileCount(requestData.jobId);
    console.log(`Current file count for job ${requestData.jobId}: ${currentFileCount}`);

    // Validate files
    const validation = validateFiles(requestData.files, config);
    if (!validation.isValid) {
      const errorResponse = new ApiResponse(false, undefined, validation.errors.join(', '));
      return LambdaResponse.error(errorResponse, 400);
    }

    // Start transaction - Hard delete all existing files for the job first using transaction
    console.log(`Using transaction to replace all files for job: ${requestData.jobId}`);
    const deleteResult = await deleteAndSaveFilesInTransaction(requestData.jobId, requestData.files, userInfo);
    
    if (!deleteResult.success) {
      const errorResponse = new ApiResponse(false, undefined, deleteResult.error || 'Failed to replace files');
      return LambdaResponse.error(errorResponse, 500);
    }

    // Count successful saves
    const successful = deleteResult.results.filter(r => r.status === 'SUCCESS').length;
    const failed = deleteResult.results.filter(r => r.status === 'FAILED').length;

    console.log(`Replace operation completed: ${successful} successful, ${failed} failed`);

    const responseData: SaveFileUrlsResponse = {
      totalFiles: deleteResult.results.length,
      successfulSaves: successful,
      failedSaves: failed,
      results: deleteResult.results,
      replacedExisting: deleteResult.deletedCount > 0,
      deletedCount: deleteResult.deletedCount
    };

    const successResponse = new ApiResponse(true, responseData, 
      `Replaced job files: ${successful} new files saved successfully${failed > 0 ? `, ${failed} failed` : ''}${deleteResult.deletedCount > 0 ? `, ${deleteResult.deletedCount} old files deleted` : ''}`);
    return LambdaResponse.success(successResponse, 200);

  } catch (error) {
    console.error('Error in save-file-urls lambda:', error);
    const errorResponse = new ApiResponse(false, undefined, 'An error occurred while saving file URLs');
    return LambdaResponse.error(errorResponse, 500);
  }
};

function parseRequestData(event: APIGatewayProxyEvent): SaveFileUrlsRequest {
  const queryParams = event.queryStringParameters || {};
  let body = {};
  
  if (event.body) {
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (err) {
      console.warn('Failed to parse event.body:', err);
      body = {};
    }
  }
  
  const directData = (!event.queryStringParameters && !event.body) ? event : {};
  const sourceData: any = { ...queryParams, ...body, ...directData };

  return {
    jobId: sourceData.jobId || sourceData.job_id,
    files: sourceData.files || [],
    userId: sourceData.userId || sourceData.user_id
  };
}

function getUserInfo(headers: APIGatewayProxyEventHeaders | undefined, inputUserId?: string): { userId: string; userName: string } {
  if (inputUserId) {
    const tokenInfo = getLoginUserInfo(headers);
    return { 
      userId: inputUserId, 
      userName: tokenInfo.userName || 'Direct User' 
    };
  }
  return getLoginUserInfo(headers);
}

async function getUploadConfig(): Promise<FileUploadConfig | null> {
  try {
    const query = `
      SELECT config_key, config_value, data_type 
      FROM file_upload_config 
      WHERE is_active = true
    `;
    
    const result = await executeQuery(query, []);
    if (!result.success) {
      console.error('Failed to get upload config:', result.error);
      return null;
    }

    const configMap = new Map();
    result.data.forEach((row: any) => {
      let value = row.config_value;
      if (row.data_type === 'number') {
        value = parseFloat(value);
      } else if (row.data_type === 'json') {
        value = JSON.parse(value);
      } else if (row.data_type === 'boolean') {
        value = value.toLowerCase() === 'true';
      }
      configMap.set(row.config_key, value);
    });

    return {
      maxFilesPerJob: configMap.get('MAX_FILES_PER_JOB') || 10,
      supportedFileTypes: configMap.get('SUPPORTED_FILE_TYPES') || [],
      supportedFileExtensions: configMap.get('SUPPORTED_FILE_EXTENSIONS') || []
    };
  } catch (error) {
    console.error('Error getting upload config:', error);
    return null;
  }
}

async function getCurrentFileCount(jobId: string): Promise<number> {
  try {
    const query = `
      SELECT COUNT(*) as count 
      FROM job_attachments 
      WHERE job_id = $1 AND upload_status = 'ACTIVE'
    `;
    
    const result = await executeQuery(query, [jobId]);
    if (!result.success) {
      console.error('Failed to get current file count:', result.error);
      return 0;
    }

    return parseInt(result.data[0]?.count || '0');
  } catch (error) {
    console.error('Error getting current file count:', error);
    return 0;
  }
}

function validateFiles(files: FileUrlData[], config: FileUploadConfig): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check file count limit first
  if (files.length > config.maxFilesPerJob) {
    errors.push(`Cannot upload more than ${config.maxFilesPerJob} files in a single request`);
    return { isValid: false, errors };
  }

  files.forEach((file, index) => {
    if (!file.fileUrl || !file.originalFilename) {
      errors.push(`File ${index + 1} is missing required fields (fileUrl or originalFilename)`);
      return;
    }

    if (!isValidUrl(file.fileUrl)) {
      errors.push(`File ${index + 1} (${file.originalFilename}) has invalid URL format`);
    }

    const extension = getFileExtension(file.originalFilename);
    if (extension && !config.supportedFileExtensions.includes(extension.toLowerCase())) {
      errors.push(`File ${index + 1} (${file.originalFilename}) has unsupported extension: ${extension}`);
    }

    if (file.fileType && !config.supportedFileTypes.includes(file.fileType)) {
      errors.push(`File ${index + 1} (${file.originalFilename}) has unsupported type: ${file.fileType}`);
    }
  });

  return { isValid: errors.length === 0, errors };
}

/**
 * NEW FUNCTION: Delete existing files and save new files in a single transaction
 * This replaces the old separate delete + loop insert approach
 */
async function deleteAndSaveFilesInTransaction(
  jobId: string, 
  files: FileUrlData[], 
  userInfo: { userId: string; userName: string }
): Promise<{ success: boolean; error?: string; results: SaveResult[]; deletedCount: number }> {
  try {
    console.log(`Starting transaction for job ${jobId} with ${files.length} files`);
    
    const operations: Operation[] = [];
    
    // 1. Get current files count for logging
    operations.push({
      type: 'query',
      queryText: `SELECT COUNT(*) as count FROM job_attachments WHERE job_id = $1 AND upload_status = 'ACTIVE'`,
      params: [jobId]
    });
    
    // 2. Delete existing files
    operations.push({
      type: 'delete',
      table: 'job_attachments',
      condition: {
        job_id: jobId,
        upload_status: 'ACTIVE'
      },
      returningClause: 'id'
    });
    
    // 3. Insert new files
    files.forEach(file => {
      const fileExtension = getFileExtension(file.originalFilename);
      const fileType = file.fileType || inferFileTypeFromExtension(fileExtension);
      
      operations.push({
        type: 'insert',
        table: 'job_attachments',
        data: {
          job_id: jobId,
          file_url: file.fileUrl,
          original_filename: file.originalFilename,
          file_type: fileType,
          file_extension: fileExtension,
          file_size: file.fileSize || null,
          upload_status: 'ACTIVE',
          created_by: userInfo.userId,
          modified_by: userInfo.userId
        },
        returningClause: 'id, original_filename, file_type, file_size'
      });
    });

    console.log(`Executing transaction with ${operations.length} operations`);
    
    const transactionResult = await performTransaction(operations);

    if (!transactionResult.success) {
      console.error('Transaction failed:', transactionResult.error);
      return {
        success: false,
        error: `Transaction failed: ${transactionResult.error}`,
        results: [],
        deletedCount: 0
      };
    }

    if (!transactionResult.results || transactionResult.results.length === 0) {
      return {
        success: false,
        error: 'Transaction succeeded but no results returned',
        results: [],
        deletedCount: 0
      };
    }

    // Process results
    const countResult = transactionResult.results[0];
    const deleteResult = transactionResult.results[1];
    const insertResults = transactionResult.results.slice(2);

    const deletedCount = parseInt(countResult?.[0]?.count || '0');
    
    console.log(`Transaction completed successfully:`);
    console.log(`- Deleted ${deletedCount} existing files`);
    console.log(`- Inserted ${insertResults.length} new files`);

    // Build results in the same format as original code
    const results: SaveResult[] = [];
    
    files.forEach((file, index) => {
      const insertResult = insertResults[index];
      
      if (insertResult && insertResult.length > 0) {
        const insertedData = insertResult[0];
        
        results.push({
          id: insertedData.id,
          fileUrl: file.fileUrl,
          originalFilename: file.originalFilename,
          fileType: insertedData.file_type || file.fileType || inferFileTypeFromExtension(getFileExtension(file.originalFilename)),
          fileSize: insertedData.file_size || file.fileSize,
          status: 'SUCCESS'
        });
      } else {
        results.push({
          id: '',
          fileUrl: file.fileUrl,
          originalFilename: file.originalFilename,
          fileType: file.fileType || '',
          fileSize: file.fileSize,
          status: 'FAILED',
          error: 'Insert result not found'
        });
      }
    });

    return {
      success: true,
      results,
      deletedCount
    };

  } catch (error) {
    console.error('Error in transaction:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown transaction error',
      results: [],
      deletedCount: 0
    };
  }
}

async function saveFileUrl(
  file: FileUrlData, 
  jobId: string, 
  userInfo: { userId: string; userName: string }
): Promise<SaveResult> {
  const fileExtension = getFileExtension(file.originalFilename);
  const fileType = file.fileType || inferFileTypeFromExtension(fileExtension);

  try {
    // Insert without manual UUID - let database generate it
    const insertQuery = `
      INSERT INTO job_attachments (
        job_id, file_url, original_filename, file_type, file_extension,
        file_size, upload_status, created_by, modified_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `;

    const params = [
      jobId, file.fileUrl, file.originalFilename, fileType,
      fileExtension, file.fileSize || null, 'ACTIVE', userInfo.userId, userInfo.userId
    ];

    const dbResult = await executeQuery(insertQuery, params);
    if (!dbResult.success) {
      throw new Error(`Database insert failed: ${dbResult.error}`);
    }

    // Get the database-generated UUID
    const generatedFileId = dbResult.data[0].id;

    return {
      id: generatedFileId,
      fileUrl: file.fileUrl,
      originalFilename: file.originalFilename,
      fileType: fileType,
      fileSize: file.fileSize,
      status: 'SUCCESS'
    };

  } catch (error) {
    console.error(`Save failed for ${file.originalFilename}:`, error);
    throw error;
  }
}

/**
 * Delete all existing files for a job (hard delete)
 */
async function deleteAllJobFiles(jobId: string, userId: string): Promise<{ success: boolean; deletedCount: number }> {
  try {
    const query = `
      DELETE FROM job_attachments 
      WHERE job_id = $1 AND upload_status = 'ACTIVE'
      RETURNING id, original_filename
    `;

    const result = await executeQuery(query, [jobId]);
    if (!result.success) {
      console.error('Failed to delete existing job files:', result.error);
      return { success: false, deletedCount: 0 };
    }

    const deletedCount = result.data.length;
    if (deletedCount > 0) {
      const deletedFiles = result.data.map((file: any) => file.original_filename).join(', ');
      console.log(`Successfully hard deleted ${deletedCount} existing files for job ${jobId}: [${deletedFiles}]`);
    } else {
      console.log(`No existing files found to delete for job: ${jobId}`);
    }
    
    return { success: true, deletedCount };

  } catch (error) {
    console.error('Error deleting existing job files:', error);
    return { success: false, deletedCount: 0 };
  }
}

function getFileExtension(filename: string): string {
  const lastDotIndex = filename.lastIndexOf('.');
  return lastDotIndex > -1 ? filename.substring(lastDotIndex) : '';
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return url.startsWith('/') || url.includes('://');
  }
}

function inferFileTypeFromExtension(extension: string): string {
  const typeMap: { [key: string]: string } = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  
  return typeMap[extension.toLowerCase()] || 'application/octet-stream';
}