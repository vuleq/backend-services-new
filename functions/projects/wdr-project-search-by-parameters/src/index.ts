import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { isValidDate } from 'wdr-common-utils';
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

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

const roleEnum: Record<string, number> = {
  'Super User': 0,
  'SRM': 1,
  'Safety Officer': 2,
  'Commercial Officer Admin': 3,
  'Commercial Officer': 4,
  'Guest': 5
};

interface Project {
  id: string;
  main_code: string;
  vessel_name: string;
  status: number;
  actual_start_date: Date;
  actual_complete_date: Date;
  created_date: Date;
  srm_users: string[];
  wdrs_completed: string;
  total_jobs: string;
  complete_job: string;
}

const getDateOnly = (dateString: string): string => {
  return new Date(dateString).toISOString().split('T')[0];
};

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Receive Event:', event);

  try {
    // Use multiValueQueryStringParameters for arrays, fallback to single values
    const queryParams = event.queryStringParameters || {};
    const multiValueParams = event.multiValueQueryStringParameters || {};

    const searchString = queryParams['search-text'];
    const status = (multiValueParams.status && multiValueParams.status.length > 0)
      ? multiValueParams.status
      : (queryParams.status ? [queryParams.status] : []);
    const sortBy = queryParams['sort-by'] ?? 'actual_start_date';
    const srm = (multiValueParams.srm && multiValueParams.srm.length > 0)
      ? multiValueParams.srm
      : (queryParams.srm ? [queryParams.srm] : []);
    const offset = queryParams['page-number'] ?? '0';
    const orderBy = queryParams['order-by'];
    const limit = queryParams['page-size'] ?? '5';
    const startDateFrom = queryParams['start-date-from']; // Actual Start date
    const startDateTo = queryParams['start-date-to'];
    const completionDateFrom = queryParams['completion-date-from']; // Actual Completion date 
    const completionDateTo = queryParams['completion-date-to'];

    // Build WHERE clause based on provided filters (excluding SRM)
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (searchString) {
      const searchPattern = `%${searchString}%`;
      conditions.push(`(p.main_code ILIKE $${paramIndex++} OR p.vessel_name ILIKE $${paramIndex++})`);
      params.push(searchPattern, searchPattern);
    }

    if (status && status.length > 0) {
      const statusValues = status.map(s => projectStatus[s]).filter(s => s !== undefined);
      if (statusValues.length != status.length) {
        return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid status'));
      }

      if (statusValues.length > 0) {
        conditions.push(`p.status = ANY($${paramIndex++})`);
        params.push(statusValues);
      }
    }

    if (startDateFrom && isValidDate(startDateFrom) && startDateTo && isValidDate(startDateTo)) {
      if (new Date(startDateFrom) > new Date(startDateTo)) {
        return new LambdaResponse(400, new ApiResponse(false, null, 'start-date-from must be before start-date-to'));
      }
      conditions.push(`DATE(p.actual_start_date) BETWEEN $${paramIndex++} AND $${paramIndex++}`);
      params.push(getDateOnly(startDateFrom), getDateOnly(startDateTo));
    }

    if (completionDateFrom && isValidDate(completionDateFrom) && completionDateTo && isValidDate(completionDateTo)) {
      if (new Date(completionDateFrom) > new Date(completionDateTo)) {
        return new LambdaResponse(400, new ApiResponse(false, null, 'completion-date-from must be before completion-date-to'));
      }
      conditions.push(`DATE(p.actual_complete_date) BETWEEN $${paramIndex++} AND $${paramIndex++}`);
      params.push(getDateOnly(completionDateFrom), getDateOnly(completionDateTo));
    }

    // Build count query first
    let countQuery = `SELECT COUNT(DISTINCT p.id) as total_count FROM projects p`;

    // Build main data query with subqueries to avoid duplication
    let query = `SELECT 
      p.id, 
      p.main_code, 
      p.vessel_name, 
      p.status,
      p.created_date,
      p.actual_start_date,
      p.actual_complete_date,
      COALESCE(srm_data.srm_users, ARRAY[]::jsonb[]) as srm_users,
      COALESCE(job_stats.wdrs_completed, 0) as wdrs_completed,
      COALESCE(job_stats.total_jobs, 0) as total_jobs,
      COALESCE(job_stats.complete_job, 0) as complete_job
    FROM projects p`;

    query += ` LEFT JOIN (
        SELECT 
          pa.project_id,
          ARRAY_AGG(jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email)) as srm_users
        FROM project_assignments pa
        JOIN users u ON u.id = pa.user_id
        WHERE pa.role = ${roleEnum['SRM']}
        GROUP BY pa.project_id
      ) srm_data ON p.id = srm_data.project_id
      LEFT JOIN (
        SELECT 
          j.project_id,
          COUNT(CASE WHEN j.wdr_status = ${WDRStatus['Completed']} THEN 1 END) as wdrs_completed,
          COUNT(j.id) as total_jobs,
          COUNT(CASE WHEN j.status = ${jobStatus.Completed} THEN 1 END) as complete_job
        FROM jobs j
        GROUP BY j.project_id
      ) job_stats ON p.id = job_stats.project_id`;

    // Handle SRM filtering with EXISTS clause
    if (srm && srm.length > 0) {
      params.push(srm);
      const srmParamIndex = paramIndex++;
      query += ` WHERE EXISTS (SELECT 1 FROM project_assignments pa WHERE pa.project_id = p.id AND pa.user_id = ANY($${srmParamIndex}) AND pa.role = ${roleEnum['SRM']})`;
      countQuery += ` WHERE EXISTS (SELECT 1 FROM project_assignments pa WHERE pa.project_id = p.id AND pa.user_id = ANY($${srmParamIndex}) AND pa.role = ${roleEnum['SRM']})`;
    }

    if (conditions.length > 0) {
      const whereClause = (srm && srm.length > 0) ? ' AND ' + conditions.join(' AND ') : ' WHERE ' + conditions.join(' AND ');
      query += whereClause;
      countQuery += whereClause;
    }

    const validSortColumns = ['main_code', 'vessel_name', 'status', 'created_date', 'wdrs_completed', 'complete_job', 'actual_start_date', 'actual_complete_date'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'actual_start_date';
    const sortOrder = orderBy?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    if (['wdrs_completed', 'complete_job'].includes(sortColumn)) {
      query += ` ORDER BY ${sortColumn} ${sortOrder}`;
    } else {
      query += ` ORDER BY p.${sortColumn} ${sortOrder}`;
    }

    const limitNum = parseInt(limit, 10) || 5;
    const offsetNum = parseInt(offset, 10) || 0;

    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limitNum, offsetNum * limitNum);

    console.log('Query: ', query);
    console.log('Params: ', params);

    // Execute count query with only filter parameters (exclude LIMIT/OFFSET)
    const countParams = params.slice(0, -2); // Remove LIMIT and OFFSET
    const countResult = await executeQuery(countQuery, countParams);
    const total = countResult.success ? parseInt(countResult.data[0].total_count) || 0 : 0;

    // Execute main query
    const result = await executeQuery(query, params);

    if (!result.success) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Error executing query', result.error));
    }

    const responseData = result.data.map((project: Project) => ({
      id: project.id,
      main_code: project.main_code,
      vessel_name: project.vessel_name,
      status: statusNames[project.status],
      created_date: project.created_date,
      actual_start_date: project.actual_start_date,
      actual_complete_date: project.actual_complete_date,
      srm: project.srm_users || [],
      wdrs_completed: parseInt(project.wdrs_completed, 10) || 0,
      total_jobs: parseInt(project.total_jobs, 10) || 0,
      complete_job: parseInt(project.complete_job, 10) || 0
    }));

    return new LambdaResponse(200, new ApiResponse(true, { pageNumber: offsetNum, pageSize: limitNum, totalCount: total, data: responseData }));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(400, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};