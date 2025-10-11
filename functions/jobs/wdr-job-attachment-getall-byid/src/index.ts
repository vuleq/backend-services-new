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

// Helper function to combine full name
const combineFullName = (user: any) => {
  if (!user) return null;
  const names = [user.given_name, user.middle_name, user.family_name]
    .filter(name => name && name.trim() !== '');
  return names.length > 0 ? names.join(' ') : null;
}

// Interfaces
interface GetAllFilesByJobRequest {
  jobId: string;
  includeDeleted?: boolean;
  sortBy?: 'created_at' | 'modified_at' | 'filename' | 'file_size';
  sortOrder?: 'ASC' | 'DESC';
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
  createdName?: string; // Added new field
}

interface JobReport {
  id: string;
  name: string;
  type: number;
  status: string;
  version?: string;
  isDefault: boolean;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  documentNo?: string;
  awrfNo?: string;
  subCode?: string;
  thumbnailUrl?: string;
  createdName?: string; // Added new field for reports
}

interface GetAllFilesByJobResponse {
  jobId: string;
  files: FileAttachment[];
  listReport: JobReport[];
  summary: {
    totalFiles: number;
    activeFiles: number;
    deletedFiles: number;
    totalSize: number;
    totalSizeFormatted: string;
    totalReports: number;
    activeReports: number;
  };
  filters: {
    includeDeleted: boolean;
    sortBy: string;
    sortOrder: string;
  };
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Get all files by job event:', JSON.stringify(event, null, 2));

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
    const { filesQuery, summaryQuery, reportsQuery, params, reportsParams } = buildJobFilesQueries(requestData);
    
    console.log('Generated files query:', filesQuery);
    console.log('Generated summary query:', summaryQuery);
    console.log('Generated reports query:', reportsQuery);
    console.log('Query params:', params);
    console.log('Reports params:', reportsParams);

    // Execute files query
    const filesResult = await executeQuery(filesQuery, params);
    if (!filesResult.success) {
      console.error('Files query failed:', filesResult.error);
      const errorResponse = new ApiResponse(false, undefined, 'Failed to fetch files');
      return LambdaResponse.error(errorResponse, 500);
    }

    // Execute summary query
    const summaryResult = await executeQuery(summaryQuery, [requestData.jobId]);
    if (!summaryResult.success) {
      console.error('Summary query failed:', summaryResult.error);
      const errorResponse = new ApiResponse(false, undefined, 'Failed to fetch file summary');
      return LambdaResponse.error(errorResponse, 500);
    }

    // Execute reports query
    const reportsResult = await executeQuery(reportsQuery, reportsParams);
    if (!reportsResult.success) {
      console.error('Reports query failed:', reportsResult.error);
      const errorResponse = new ApiResponse(false, undefined, 'Failed to fetch reports');
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
      createdName: combineFullName(file) // Add the combined full name
    }));

    // Format reports data
    const formattedReports: JobReport[] = reportsResult.data.map((report: any) => ({
      id: report.id,
      name: report.name,
      type: report.type,
      status: report.status,
      version: report.version,
      isDefault: report.is_default || false,
      isPublished: report.is_published || false,
      createdAt: report.created_at,
      updatedAt: report.updated_at,
      createdBy: report.created_by,
      updatedBy: report.updated_by,
      documentNo: report.document_no,
      awrfNo: report.awrf_no,
      subCode: report.sub_code,
      thumbnailUrl: report.thumbnail,
      createdName: combineFullName(report) // Add the combined full name for reports
    }));

    // Calculate summary statistics
    const summary = calculateSummary(summaryResult.data, formattedReports);

    // Format response
    const responseData: GetAllFilesByJobResponse = {
      jobId: requestData.jobId,
      files: formattedFiles,
      listReport: formattedReports,
      summary: summary,
      filters: {
        includeDeleted: requestData.includeDeleted!,
        sortBy: requestData.sortBy!,
        sortOrder: requestData.sortOrder!
      }
    };

    console.log(`Successfully retrieved ${formattedFiles.length} files and ${formattedReports.length} reports for job ${requestData.jobId}`);
    console.log(`Summary: ${summary.activeFiles} active files, ${summary.deletedFiles} deleted files, ${summary.activeReports} reports, ${summary.totalSizeFormatted} total size`);

    const successResponse = new ApiResponse(true, responseData, `Retrieved ${formattedFiles.length} files and ${formattedReports.length} reports for job ${requestData.jobId}`);
    return LambdaResponse.success(successResponse, 200);

  } catch (error) {
    console.error('Error in get-all-files-by-job lambda:', error);
    const errorResponse = new ApiResponse(false, undefined, 'An error occurred while fetching files');
    return LambdaResponse.error(errorResponse, 500);
  }
};

function parseRequestData(event: APIGatewayProxyEvent): GetAllFilesByJobRequest {
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

function validateSortParameters(request: GetAllFilesByJobRequest): { isValid: boolean; errors: string[] } {
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

function buildJobFilesQueries(request: GetAllFilesByJobRequest): { 
  filesQuery: string; 
  summaryQuery: string; 
  reportsQuery: string;
  params: any[];
  reportsParams: any[];
} {
  const filesBaseQuery = `
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
      u.family_name,
      u.given_name,
      u.middle_name
    FROM job_attachments ja
    LEFT JOIN users u ON ja.created_by = u.id
  `;

  const summaryQuery = `
    SELECT 
      upload_status,
      COUNT(*) as count,
      COALESCE(SUM(file_size), 0) as total_size
    FROM job_attachments
    WHERE job_id = $1
    GROUP BY upload_status
  `;

  // Reports query - with user info for created_by
  const reportsQuery = `
    SELECT 
      r.id,
      r.name,
      r.type,
      r.status,
      r.version,
      r.is_default,
      r.is_published,
      r.created_at,
      r.updated_at,
      r.created_by,
      r.updated_by,
      r.document_no,
      r.awrf_no,
      r.sub_code,
      r.thumbnail,
      u.family_name,
      u.given_name,
      u.middle_name
    FROM report r
    LEFT JOIN users u ON r.created_by = u.id
    WHERE r.job_id = $1
    ORDER BY r.created_at DESC
  `;

  const whereClauses: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  // Job ID filter (always required)
  whereClauses.push(`ja.job_id = $${paramIndex++}`);
  params.push(request.jobId);

  // Include deleted filter
  if (!request.includeDeleted) {
    whereClauses.push(`ja.upload_status = $${paramIndex++}`);
    params.push('ACTIVE');
  }

  // Build WHERE clause
  const whereClause = `WHERE ${whereClauses.join(' AND ')}`;

  // Build ORDER BY clause
  let orderBy: string;
  
  if (request.sortBy === 'created_at') {
    orderBy = `ORDER BY ja.created_at ${request.sortOrder!}`;
  } else {
    let secondaryField: string = request.sortBy!;
    if (secondaryField === 'filename') {
      secondaryField = 'ja.original_filename';
    } else {
      secondaryField = `ja.${secondaryField}`;
    }
    orderBy = `ORDER BY ja.created_at DESC, ${secondaryField} ${request.sortOrder!}`;
  }

  // Complete files query
  const filesQuery = `${filesBaseQuery} ${whereClause} ${orderBy}`;

  // Reports params (just jobId)
  const reportsParams = [request.jobId];

  return { filesQuery, summaryQuery, reportsQuery, params, reportsParams };
}

function calculateSummary(summaryData: any[], reports: JobReport[]): {
  totalFiles: number;
  activeFiles: number;
  deletedFiles: number;
  totalSize: number;
  totalSizeFormatted: string;
  totalReports: number;
  activeReports: number;
} {
  let totalFiles = 0;
  let activeFiles = 0;
  let deletedFiles = 0;
  let totalSize = 0;

  summaryData.forEach((row: any) => {
    const count = parseInt(row.count || '0');
    const size = parseInt(row.total_size || '0');
    
    totalFiles += count;
    totalSize += size;

    if (row.upload_status === 'ACTIVE') {
      activeFiles = count;
    } else if (row.upload_status === 'DELETED') {
      deletedFiles = count;
    }
  });

  // Calculate report statistics
  const totalReports = reports.length;
  const activeReports = reports.filter(report => 
    report.status !== 'DELETED' && report.status !== 'ARCHIVED'
  ).length;

  return {
    totalFiles,
    activeFiles,
    deletedFiles,
    totalSize,
    totalSizeFormatted: formatFileSize(totalSize),
    totalReports,
    activeReports
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