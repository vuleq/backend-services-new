import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

const defaultUserId = "00000000-0000-0000-0000-000000000000";
const defaultUserName = 'PaxOcean Admin';
const headOfDepartmentCode = 'HOD';

const projectStatus: Record<string, number> = {
  'Not started': 0,
  Started: 1,
  Completed: 2,
  Closed: 3
};

const statusNames: Record<number, string> = {
  0: 'Not started',
  1: 'Started',
  2: 'Completed',
  3: 'Closed'
};

const jobStatus = {
  Completed: 4
}

const WDRStatus: Record<string, number> = {
  'Not started': 0,
  Draft: 1,
  'Pre review': 2,
  'HOD review': 3,
  'SRM review': 4,
  Completed: 5
}

const WDRStatusNames: Record<number, string> = {
  0: 'Not started',
  1: 'Draft',
  2: 'Pre review',
  3: 'HOD review',
  4: 'SRM review',
  5: 'Completed'
}

const roleEnum: Record<string, number> = {
  'Super User': 0,
  'SRM': 1,
  'Safety Officer': 2,
  'Commercial Officer Admin': 3,
  'Commercial Officer': 4,
  'Guest': 5
};

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
interface GetFilesRequest {
  jobId: string;
  page?: number;
  limit?: number;
  userId?: string;
}

interface FileAttachment {
  id: string;
  jobId: string;
  fileUrl: string;
  originalFilename: string;
  fileType: string;
  fileExtension: string;
  fileSize?: number;
  fileSizeFormatted?: string;
  uploadStatus: string;
  createdAt: string;
  modifiedAt: string;
  createdBy: string;
  modifiedBy: string;
  wdrStatus: string; // Added wdr_status field
}

interface GetFilesResponse {
  files: FileAttachment[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  jobId: string;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Get files event:', JSON.stringify(event, null, 2));

    // Parse request data
    const requestData = parseRequestData(event);
    console.log('Parsed request data:', requestData);

    // Get user info
    const userInfo = getUserInfo(event.headers, requestData.userId);
    console.log('User info:', userInfo);

    // Validate required fields
    if (!requestData.jobId) {
      const errorResponse = new ApiResponse(false, undefined, 'Missing required field: jobId');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate pagination
    const validation = validatePagination(requestData);
    if (!validation.isValid) {
      const errorResponse = new ApiResponse(false, undefined, validation.errors.join(', '));
      return LambdaResponse.error(errorResponse, 400);
    }

    // Build query with pagination
    const { query, countQuery, params } = buildFilesQuery(requestData);
    
    console.log('Generated query:', query);
    console.log('Query params:', params);

    // Execute count query for pagination
    const countResult = await executeQuery(countQuery, params.slice(0, 1));
    if (!countResult.success) {
      console.error('Count query failed:', countResult.error);
      const errorResponse = new ApiResponse(false, undefined, 'Failed to count files');
      return LambdaResponse.error(errorResponse, 500);
    }

    const total = parseInt(countResult.data[0]?.count || '0');
    const totalPages = Math.ceil(total / requestData.limit!);

    // Execute main query with pagination
    const filesResult = await executeQuery(query, params);
    if (!filesResult.success) {
      console.error('Files query failed:', filesResult.error);
      const errorResponse = new ApiResponse(false, undefined, 'Failed to fetch files');
      return LambdaResponse.error(errorResponse, 500);
    }

    // Format file data
    const formattedFiles: FileAttachment[] = filesResult.data.map((file: any) => ({
      id: file.id,
      jobId: file.job_id,
      fileUrl: file.file_url,
      originalFilename: file.original_filename,
      fileType: file.file_type,
      fileExtension: file.file_extension,
      fileSize: file.file_size,
      fileSizeFormatted: file.file_size ? formatFileSize(file.file_size) : undefined,
      uploadStatus: file.upload_status,
      createdAt: file.created_at,
      modifiedAt: file.modified_at,
      createdBy: file.created_by,
      modifiedBy: file.modified_by,
      wdrStatus: WDRStatusNames[file.wdr_status] || 'Unknown' // Map wdr_status number to string
    }));

    // Format response
    const responseData: GetFilesResponse = {
      files: formattedFiles,
      pagination: {
        page: requestData.page!,
        limit: requestData.limit!,
        total,
        totalPages
      },
      jobId: requestData.jobId
    };

    console.log(`Successfully retrieved ${formattedFiles.length} files for job ${requestData.jobId} (${total} total)`);

    const successResponse = new ApiResponse(true, responseData, `Retrieved ${formattedFiles.length} files for job`);
    return LambdaResponse.success(successResponse, 200);

  } catch (error) {
    console.error('Error in get-files lambda:', error);
    const errorResponse = new ApiResponse(false, undefined, 'An error occurred while fetching files');
    return LambdaResponse.error(errorResponse, 500);
  }
};

function parseRequestData(event: APIGatewayProxyEvent): GetFilesRequest {
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
    page: parseInt(sourceData.page || '1'),
    limit: Math.min(parseInt(sourceData.limit || '50'), 1000),
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

function validatePagination(request: GetFilesRequest): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (request.page && (request.page < 1 || request.page > 10000)) {
    errors.push('Page must be between 1 and 10000');
  }

  if (request.limit && (request.limit < 1 || request.limit > 1000)) {
    errors.push('Limit must be between 1 and 1000');
  }

  return { isValid: errors.length === 0, errors };
}

function buildFilesQuery(request: GetFilesRequest): { query: string; countQuery: string; params: any[] } {
  const baseQuery = `
    SELECT 
      ja.id,
      ja.job_id,
      ja.file_url,
      ja.original_filename,
      ja.file_type,
      ja.file_extension,
      ja.file_size,
      ja.upload_status,
      ja.created_at,
      ja.modified_at,
      ja.created_by,
      ja.modified_by,
      j.wdr_status
    FROM job_attachments ja
    LEFT JOIN jobs j ON ja.job_id = j.id
  `;

  const countBaseQuery = `
    SELECT COUNT(*) as count 
    FROM job_attachments ja
    LEFT JOIN jobs j ON ja.job_id = j.id
  `;
  
  const whereClauses: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  // Job ID filter (always required)
  whereClauses.push(`ja.job_id = $${paramIndex++}`);
  params.push(request.jobId);

  // Only show active files
  whereClauses.push(`ja.upload_status = $${paramIndex++}`);
  params.push('ACTIVE');

  // Build WHERE clause
  const whereClause = `WHERE ${whereClauses.join(' AND ')}`;

  // Order by created_at DESC (newest first)
  const orderBy = 'ORDER BY ja.created_at DESC';

  // Add pagination
  const offset = (request.page! - 1) * request.limit!;
  const limit = `LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
  params.push(request.limit!, offset);

  // Complete queries
  const query = `${baseQuery} ${whereClause} ${orderBy} ${limit}`;
  const countQuery = `${countBaseQuery} ${whereClause}`;

  return { query, countQuery, params };
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  const size = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
  return `${size} ${sizes[i]}`;
}