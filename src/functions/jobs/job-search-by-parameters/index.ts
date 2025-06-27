import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, ResponsePage, LambdaResponse } from '/opt/nodejs/api-model';

// Define allowed job status keys
const jobStatus = {
  BLANK: null,
  PENDING: 0, 
  CONFIRMED: 1, 
  CANCELLED: 2, 
  STARTED: 3, 
  "JOB COMPLETE": 4, 
  "WDR DRAFT": 5, 
  "WDR COMPLETED": 6
} as const;

type JobStatusKey = keyof typeof jobStatus;

interface JobSearchQuery {
  'trade-section-id'?: string;
  'awrf-number'?: string;
  status?: JobStatusKey;
  'sort-by'?: string;
  limit?: string;
  'order-by'?: string;
  offset?: string;
  'main-job-id'?: string;
  'project-id'?: string;
  supervisor?: string;
  title?: string;
}

interface JobSearchEvent {
  queryStringParameters?: JobSearchQuery;
}

export const handler = async (event: JobSearchEvent) => {
  console.log('Receive Event:', event);

  try {
    const {
      'trade-section-id': tradeSectionId,
      'awrf-number': awrfNumber,
      status,
      'sort-by': sortBy,
      limit,
      'order-by': orderBy,
      offset,
      'main-job-id': mainJobId,
      'project-id': projectId,
      supervisor,
      title
    } = event.queryStringParameters || {};

    // Validate status parameter
    const statusValue = status && status in jobStatus ? jobStatus[status] : undefined;
    
    // Build WHERE clause based on provided filters
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (mainJobId) {
      conditions.push(`main_job_id = ${paramIndex++}`);
      params.push(mainJobId);
    }

    if (projectId) {
      conditions.push(`project_id = ${paramIndex++}`);
      params.push(projectId);
    }
    
    if (tradeSectionId) {
      conditions.push(`trade_section_id = ${paramIndex++}`);
      params.push(tradeSectionId);
    }
    
    if (supervisor) {
      conditions.push(`supervisor = ${paramIndex++}`);
      params.push(supervisor);
    }

    if (statusValue !== undefined) {
      conditions.push(`status = ${paramIndex++}`);
      params.push(statusValue);
    }
    
    if (title) {
      conditions.push(`title ILIKE ${paramIndex++}`);
      params.push(`%${title}%`);
    }

    if (awrfNumber) {
      conditions.push(`awrf_number = ${paramIndex++}`);
      params.push(awrfNumber);
    }
    
    const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
    
    // Safe sorting with whitelist
    const validSortColumns = ['create_date', 'status'] as const;
    const sortColumn = validSortColumns.includes(sortBy as any) ? sortBy : 'create_date';
    const sortOrder = orderBy?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    
    // Pagination
    const limitNum = Math.min(Math.max(parseInt(limit || '10', 10), 1), 100);
    const offsetNum = Math.max(parseInt(offset || '0', 10), 0);
    
    // Single query with window function for count
    const query = `
      SELECT *, COUNT(*) OVER() as total_count 
      FROM jobs${whereClause}
      ORDER BY ${sortColumn} ${sortOrder}
      LIMIT ${paramIndex++} OFFSET ${paramIndex++}
    `;
    params.push(limitNum, offsetNum);
    
    console.log('Query: ', query);
    console.log('Params: ', params);

    // Execute single query
    const result = await executeQuery(query, params);

    if (!result.success) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Error executing query', result.error));
    }

    const total = result.data.length > 0 ? parseInt(result.data[0].total_count, 10) : 0;
    
    // Remove total_count from each row
    const jobs = result.data.map((row: { total_count: number; [key: string]: any }) => {
      const { total_count, ...job } = row;
      return job;
    });

    return new LambdaResponse(200, new ResponsePage(offsetNum, limitNum, total, jobs));
  } catch (error) {
    console.error('Error:', error);
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    }
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', errorMessage));
  }
};