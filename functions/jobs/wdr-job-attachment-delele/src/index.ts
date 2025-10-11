import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { executeQuery } from 'wdr-connect-db';
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
interface DeleteFileRequest {
  fileId: string;
  jobId?: string;
  userId?: string;
}

interface FileInfo {
  id: string;
  jobId: string;
  fileUrl: string;
  originalFilename: string;
  uploadStatus: string;
  createdBy: string;
}

interface DeleteFileResponse {
  fileId: string;
  filename: string;
  jobId: string;
  deletedAt: string;
  deletedBy: string;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Delete file event:', JSON.stringify(event, null, 2));

    // Parse request data - Only from parameters
    const requestData = parseRequestData(event);
    console.log('Parsed request data:', requestData);

    // Get user info
    const userInfo = getUserInfo(event.headers, requestData.userId);
    console.log('User info:', userInfo);

    // Validate required fields
    if (!requestData.fileId) {
      const errorResponse = new ApiResponse(false, undefined, 'Missing required field: fileId. Please provide fileId as query parameter or path parameter.');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Get file information from database
    const fileInfo = await getFileInfo(requestData.fileId, requestData.jobId);
    if (!fileInfo) {
      const errorResponse = new ApiResponse(false, undefined, 'File not found or already deleted');
      return LambdaResponse.error(errorResponse, 404);
    }

    console.log('File to delete:', { fileId: fileInfo.id, filename: fileInfo.originalFilename });

    // Check if file is already deleted
    if (fileInfo.uploadStatus === 'DELETED') {
      const errorResponse = new ApiResponse(false, undefined, 'File is already deleted');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Hard delete file from database
    const dbDeleteSuccess = await hardDeleteFile(requestData.fileId);
    if (!dbDeleteSuccess) {
      const errorResponse = new ApiResponse(false, undefined, 'Failed to delete file from database');
      return LambdaResponse.error(errorResponse, 500);
    }

    console.log(`Successfully hard deleted file: ${fileInfo.originalFilename}`);

    const responseData: DeleteFileResponse = {
      fileId: requestData.fileId,
      filename: fileInfo.originalFilename,
      jobId: fileInfo.jobId,
      deletedAt: new Date().toISOString(),
      deletedBy: userInfo.userId
    };

    const successResponse = new ApiResponse(true, responseData, `File "${fileInfo.originalFilename}" deleted permanently`);
    return LambdaResponse.success(successResponse, 200);

  } catch (error) {
    console.error('Error in delete-file lambda:', error);
    const errorResponse = new ApiResponse(false, undefined, 'An error occurred while deleting the file');
    return LambdaResponse.error(errorResponse, 500);
  }
};

/**
 * Parse request data - Only from query parameters and path parameters
 * Body is ignored to ensure only parameter-based deletion
 */
function parseRequestData(event: APIGatewayProxyEvent): DeleteFileRequest {
  const queryParams = event.queryStringParameters || {};
  const pathParams = event.pathParameters || {};
  
  // Removed body parsing to enforce parameter-only deletion
  const sourceData: any = { ...queryParams, ...pathParams };

  return {
    fileId: sourceData.fileId || sourceData.file_id || sourceData.id,
    jobId: sourceData.jobId || sourceData.job_id,
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

async function getFileInfo(fileId: string, jobId?: string): Promise<FileInfo | null> {
  try {
    let query = `
      SELECT 
        id, job_id, file_url, original_filename, upload_status, created_by
      FROM job_attachments 
      WHERE id = $1
    `;
    const params = [fileId];

    if (jobId) {
      query += ` AND job_id = $2`;
      params.push(jobId);
    }

    const result = await executeQuery(query, params);
    if (!result.success || result.data.length === 0) {
      console.error('File not found:', result.error);
      return null;
    }

    const file = result.data[0];
    return {
      id: file.id,
      jobId: file.job_id,
      fileUrl: file.file_url,
      originalFilename: file.original_filename,
      uploadStatus: file.upload_status,
      createdBy: file.created_by
    };

  } catch (error) {
    console.error('Error getting file info:', error);
    return null;
  }
}

/**
 * Hard delete file from database
 */
async function hardDeleteFile(fileId: string): Promise<boolean> {
  try {
    const query = `
      DELETE FROM job_attachments 
      WHERE id = $1 AND upload_status = 'ACTIVE'
      RETURNING id, original_filename
    `;

    const result = await executeQuery(query, [fileId]);
    if (!result.success || result.data.length === 0) {
      console.error('Failed to delete file or file not found:', result.error);
      return false;
    }

    const deletedFile = result.data[0];
    console.log(`Successfully hard deleted file: ${deletedFile.original_filename} (ID: ${deletedFile.id})`);
    return true;

  } catch (error) {
    console.error('Error hard deleting file:', error);
    return false;
  }
}