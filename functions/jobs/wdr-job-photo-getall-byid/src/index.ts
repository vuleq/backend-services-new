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

// Helper function to combine full name
const combineFullName = (user: any) => {
  if (!user) return null;
  const names = [user.given_name, user.middle_name, user.family_name]
    .filter(name => name && name.trim() !== '');
  return names.length > 0 ? names.join(' ') : null;
}

// Interfaces
interface GetAllPhotosByJobRequest {
  jobId: string;
  includeDeleted?: boolean;
  sortBy?: 'created_at' | 'modified_at' | 'filename' | 'file_size';
  sortOrder?: 'ASC' | 'DESC';
  userId?: string;
}

interface JobPhoto {
  id: string;
  jobId: string;
  photoUrl: string;
  originalFilename: string;
  fileSize?: number;
  fileSizeFormatted?: string;
  uploadStatus: string;
  createdAt: string;
  modifiedAt: string;
  createdBy: string;
  modifiedBy: string;
  createdName?: string;
}

interface GetAllPhotosByJobResponse {
  jobId: string;
  photos: JobPhoto[];
  summary: {
    totalPhotos: number;
    activePhotos: number;
    deletedPhotos: number;
    totalSize: number;
    totalSizeFormatted: string;
  };
  filters: {
    includeDeleted: boolean;
    sortBy: string;
    sortOrder: string;
  };
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Get all photos by job event:', JSON.stringify(event, null, 2));

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

    // Validate sort parameters
    const validation = validateSortParameters(requestData);
    if (!validation.isValid) {
      const errorResponse = new ApiResponse(false, undefined, validation.errors.join(', '));
      return LambdaResponse.error(errorResponse, 400);
    }

    // Build queries
    const { photosQuery, summaryQuery, params } = buildJobPhotosQueries(requestData);
    
    console.log('Generated photos query:', photosQuery);
    console.log('Generated summary query:', summaryQuery);
    console.log('Query params:', params);

    // Execute photos query
    const photosResult = await executeQuery(photosQuery, params);
    if (!photosResult.success) {
      console.error('Photos query failed:', photosResult.error);
      const errorResponse = new ApiResponse(false, undefined, 'Failed to fetch photos');
      return LambdaResponse.error(errorResponse, 500);
    }

    // Execute summary query
    const summaryResult = await executeQuery(summaryQuery, [requestData.jobId]);
    if (!summaryResult.success) {
      console.error('Summary query failed:', summaryResult.error);
      const errorResponse = new ApiResponse(false, undefined, 'Failed to fetch photo summary');
      return LambdaResponse.error(errorResponse, 500);
    }

    // Format photo data
    const formattedPhotos: JobPhoto[] = photosResult.data.map((photo: any) => ({
      id: photo.id,
      jobId: photo.job_id,
      photoUrl: photo.photo_url,
      originalFilename: photo.original_filename,
      fileSize: photo.file_size,
      fileSizeFormatted: photo.file_size ? formatFileSize(photo.file_size) : undefined,
      uploadStatus: photo.upload_status,
      createdAt: photo.created_at,
      modifiedAt: photo.modified_at,
      createdBy: photo.created_by,
      modifiedBy: photo.modified_by,
      createdName: combineFullName(photo)
    }));

    // Calculate summary statistics
    const summary = calculateSummary(summaryResult.data);

    // Format response
    const responseData: GetAllPhotosByJobResponse = {
      jobId: requestData.jobId,
      photos: formattedPhotos,
      summary: summary,
      filters: {
        includeDeleted: requestData.includeDeleted!,
        sortBy: requestData.sortBy!,
        sortOrder: requestData.sortOrder!
      }
    };

    console.log(`Successfully retrieved ${formattedPhotos.length} photos for job ${requestData.jobId}`);
    console.log(`Summary: ${summary.activePhotos} active photos, ${summary.deletedPhotos} deleted photos, ${summary.totalSizeFormatted} total size`);

    const successResponse = new ApiResponse(true, responseData, `Retrieved ${formattedPhotos.length} photos for job ${requestData.jobId}`);
    return LambdaResponse.success(successResponse, 200);

  } catch (error) {
    console.error('Error in get-all-photos-by-job lambda:', error);
    const errorResponse = new ApiResponse(false, undefined, 'An error occurred while fetching photos');
    return LambdaResponse.error(errorResponse, 500);
  }
};

function parseRequestData(event: APIGatewayProxyEvent): GetAllPhotosByJobRequest {
  const queryParams = event.queryStringParameters || {};
  const pathParams = event.pathParameters || {};
  let body = {};
  
  if (event.body) {
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (err) {
      console.warn('Failed to parse event.body:', err);
      body = {};
    }
  }
  
  const directData = (!event.queryStringParameters && !event.body && !event.pathParameters) ? event : {};
  const sourceData: any = { ...queryParams, ...pathParams, ...body, ...directData };

  return {
    jobId: sourceData.jobId || sourceData.job_id,
    includeDeleted: parseBoolean(sourceData.includeDeleted || sourceData.include_deleted, false),
    sortBy: sourceData.sortBy || sourceData.sort_by || 'created_at',
    sortOrder: (sourceData.sortOrder || sourceData.sort_order || 'DESC').toUpperCase() as 'ASC' | 'DESC',
    userId: sourceData.userId || sourceData.user_id
  };
}

function parseBoolean(value: any, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }
  return defaultValue;
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

function validateSortParameters(request: GetAllPhotosByJobRequest): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  const validSortFields = ['created_at', 'modified_at', 'filename', 'file_size'];
  if (!validSortFields.includes(request.sortBy!)) {
    errors.push(`Invalid sortBy. Valid values: ${validSortFields.join(', ')}`);
  }

  const validSortOrders = ['ASC', 'DESC'];
  if (!validSortOrders.includes(request.sortOrder!)) {
    errors.push(`Invalid sortOrder. Valid values: ${validSortOrders.join(', ')}`);
  }

  return { isValid: errors.length === 0, errors };
}

function buildJobPhotosQueries(request: GetAllPhotosByJobRequest): { 
  photosQuery: string; 
  summaryQuery: string; 
  params: any[];
} {
  const photosBaseQuery = `
    SELECT 
      jp.id,
      jp.job_id,
      jp.photo_url,
      jp.original_filename,
      jp.file_size,
      jp.upload_status,
      jp.created_at,
      jp.modified_at,
      jp.created_by,
      jp.modified_by,
      u.family_name,
      u.given_name,
      u.middle_name
    FROM job_photos jp
    LEFT JOIN users u ON jp.created_by = u.id
  `;

  const summaryQuery = `
    SELECT 
      upload_status,
      COUNT(*) as count,
      COALESCE(SUM(file_size), 0) as total_size
    FROM job_photos
    WHERE job_id = $1
    GROUP BY upload_status
  `;

  const whereClauses: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  // Job ID filter (always required)
  whereClauses.push(`jp.job_id = $${paramIndex++}`);
  params.push(request.jobId);

  // Include deleted filter
  if (!request.includeDeleted) {
    whereClauses.push(`jp.upload_status = $${paramIndex++}`);
    params.push('ACTIVE');
  }

  // Build WHERE clause
  const whereClause = `WHERE ${whereClauses.join(' AND ')}`;

  // Build ORDER BY clause
  let orderByField: string = request.sortBy!;
  if (orderByField === 'filename') {
    orderByField = 'jp.original_filename';
  } else {
    orderByField = `jp.${orderByField}`;
  }
  
  const orderBy = `ORDER BY ${orderByField} ${request.sortOrder!}`;

  // Complete photos query
  const photosQuery = `${photosBaseQuery} ${whereClause} ${orderBy}`;

  return { photosQuery, summaryQuery, params };
}

function calculateSummary(summaryData: any[]): {
  totalPhotos: number;
  activePhotos: number;
  deletedPhotos: number;
  totalSize: number;
  totalSizeFormatted: string;
} {
  let totalPhotos = 0;
  let activePhotos = 0;
  let deletedPhotos = 0;
  let totalSize = 0;

  summaryData.forEach((row: any) => {
    const count = parseInt(row.count || '0');
    const size = parseInt(row.total_size || '0');
    
    totalPhotos += count;
    totalSize += size;

    if (row.upload_status === 'ACTIVE') {
      activePhotos = count;
    } else if (row.upload_status === 'DELETED') {
      deletedPhotos = count;
    }
  });

  return {
    totalPhotos,
    activePhotos,
    deletedPhotos,
    totalSize,
    totalSizeFormatted: formatFileSize(totalSize)
  };
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  const size = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
  return `${size} ${sizes[i]}`;
}