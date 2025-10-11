import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

const defaultUserId = "00000000-0000-0000-0000-000000000000";
const defaultUserName = 'PaxOcean Admin';

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
  userId?: string;
}

interface DeletedFileInfo {
  id: string;
  fileName: string;
  s3Url: string;
  fileType?: string;
  fileSizeBytes?: number;
}

interface DeleteFileResponse {
  deletedFile: DeletedFileInfo;
  message: string;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Delete file event:', JSON.stringify(event, null, 2));

    // Parse request data
    const requestData = parseRequestData(event);
    console.log('Parsed request data:', requestData);

    // Get user info
    const userInfo = getLoginUserInfo(event.headers);
    console.log('User info:', userInfo);

    // Validate request
    if (!requestData.fileId) {
      const errorResponse = new ApiResponse(false, undefined, 'Missing required field: fileId');
      return LambdaResponse.error(errorResponse, 400);
    }

    if (!isValidUUID(requestData.fileId)) {
      const errorResponse = new ApiResponse(false, undefined, 'Invalid fileId format');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Check if file exists and get its info
    const fileInfo = await getFileInfo(requestData.fileId);
    
    if (!fileInfo) {
      const errorResponse = new ApiResponse(false, undefined, 'File not found');
      return LambdaResponse.error(errorResponse, 404);
    }

    // Delete the file
    const deleteResult = await deleteFile(requestData.fileId);
    
    if (!deleteResult.success) {
      const errorResponse = new ApiResponse(false, undefined, deleteResult.error || 'Failed to delete file');
      return LambdaResponse.error(errorResponse, 500);
    }

    console.log(`File deleted successfully: ${fileInfo.fileName}`);

    const responseData: DeleteFileResponse = {
      deletedFile: fileInfo,
      message: `File '${fileInfo.fileName}' deleted successfully`
    };

    const successResponse = new ApiResponse(true, responseData, `File deleted successfully`);
    return LambdaResponse.success(successResponse, 200);

  } catch (error) {
    console.error('Error in delete-file lambda:', error);
    const errorResponse = new ApiResponse(false, undefined, 'An error occurred while deleting file');
    return LambdaResponse.error(errorResponse, 500);
  }
};

function parseRequestData(event: APIGatewayProxyEvent): DeleteFileRequest {
  const pathParams = event.pathParameters || {};
  const queryParams = event.queryStringParameters || {};
  
  // Try to get fileId from path parameters first, then from query string
  const fileId = pathParams.fileId || pathParams.id || queryParams.fileId || queryParams.id;
  
  return {
    fileId: fileId || '', // Ensure it's always a string, empty if not found
    userId: undefined // User info will be extracted from JWT token
  };
}

async function getFileInfo(fileId: string): Promise<DeletedFileInfo | null> {
  try {
    const query = `
      SELECT id, file_name, s3_url, file_type, file_size_bytes
      FROM files 
      WHERE id = $1
    `;
    
    const result = await executeQuery(query, [fileId]);

    if (!result.success) {
      console.error('Failed to get file info:', result.error);
      return null;
    }

    if (!result.data || result.data.length === 0) {
      console.log('File not found:', fileId);
      return null;
    }

    const fileData = result.data[0];
    return {
      id: fileData.id,
      fileName: fileData.file_name,
      s3Url: fileData.s3_url,
      fileType: fileData.file_type,
      fileSizeBytes: fileData.file_size_bytes
    };

  } catch (error) {
    console.error('Error getting file info:', error);
    return null;
  }
}

async function deleteFile(fileId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const deleteQuery = `DELETE FROM files WHERE id = $1`;
    
    console.log('Deleting file with ID:', fileId);

    const deleteResult = await executeQuery(deleteQuery, [fileId]);

    if (!deleteResult.success) {
      console.error('Failed to delete file:', deleteResult.error);
      return {
        success: false,
        error: `Failed to delete file: ${deleteResult.error}`
      };
    }

    // Check if any row was actually deleted
    if (deleteResult.rowCount === 0) {
      return {
        success: false,
        error: 'File not found or already deleted'
      };
    }

    console.log(`File deleted successfully. Rows affected: ${deleteResult.rowCount}`);

    return { success: true };

  } catch (error) {
    console.error('Error deleting file:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown deletion error'
    };
  }
}

function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}