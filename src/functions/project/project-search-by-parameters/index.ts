import { executeQuery } from '/opt/nodejs/db';
import { LambdaResponse, ApiResponse, ResponsePage } from '/opt/nodejs/api-model';

const projectStatus = {
  'Not Start': 0,
  Started: 1,
  Completed: 2,
  Closed: 3
} as const;

type ProjectStatus = keyof typeof projectStatus;
type SortColumn = 'create_date' | 'arrival_date' | 'departure_date' | 'vessel_name' | 'status';
type SortOrder = 'ASC' | 'DESC';

interface QueryParams {
  mainCode?: string;
  srm?: string;
  safetyOfficer?: string;
  projectManager?: string;
  status?: ProjectStatus;
  commercialOfficer?: string;
  vesselName?: string;
  arrivalDate?: string;
  departureDate?: string;
  sortBy: SortColumn;
  orderBy: SortOrder;
  limit: number;
  offset: number;
}

export const handler = async (event: any) => {
  console.log('Receive Event:', event);

  try {
    const queryParams = parseQueryParameters(event.queryStringParameters || {});

    // Validate date formats
    if (queryParams.arrivalDate && isNaN(Date.parse(queryParams.arrivalDate))) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid arrivalDate format. Use YYYY-MM-DD format.'));
    }

    if (queryParams.departureDate && isNaN(Date.parse(queryParams.departureDate))) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid departureDate format. Use YYYY-MM-DD format.'));
    }

    // Validate status and date range
    if (queryParams.status && !(queryParams.status in projectStatus)) {
      return new LambdaResponse(400, new ApiResponse(false, null, `Invalid status. Allowed: ${Object.keys(projectStatus).join(', ')}`));
    }
    
    if (queryParams.arrivalDate && queryParams.departureDate && 
        new Date(queryParams.arrivalDate) > new Date(queryParams.departureDate)) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Arrival date cannot be after departure date'));
    }
    
    const { query, params } = buildQuery(queryParams);
    
    console.log('Query: ', query);
    console.log('Params: ', params);

    const result = await executeQuery(query, params);

    if (!result.success) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Error fetching projects', result.error));
    }

    const total = result.data.length > 0 ? parseInt(result.data[0].total_count, 10) : 0;

    // Remove total_count from each row
    const projects = result.data.map((row: { total_count: number; [key: string]: any }) => {
      const { total_count, ...project } = row;
      return project;
    });

    return new LambdaResponse(200, new ResponsePage(queryParams.offset, queryParams.limit, total, projects));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};

function parseQueryParameters(params: Record<string, any>): QueryParams {
  const validSortColumns: SortColumn[] = ['create_date', 'arrival_date', 'departure_date', 'vessel_name', 'status'];
  const limit = Math.min(Math.max(parseInt(params.limit, 10) || 10, 1), 100);
  const offset = Math.max(parseInt(params.offset, 10) || 0, 0);
  
  const sanitize = (value: string | undefined) => value?.trim() || undefined;
  
  return {
    mainCode: sanitize(params['main-code']),
    srm: sanitize(params.srm),
    safetyOfficer: sanitize(params['safety-officer']),
    projectManager: sanitize(params['project-manager']),
    status: params.status as ProjectStatus,
    commercialOfficer: sanitize(params['commercial-officer']),
    vesselName: sanitize(params['vessel-name']),
    arrivalDate: sanitize(params['arrival-date']),
    departureDate: sanitize(params['departure-date']),
    sortBy: validSortColumns.includes(params['sort-by'] as SortColumn) ? params['sort-by'] : 'create_date',
    orderBy: params['order-by']?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
    limit,
    offset
  };
}

function buildQuery(params: QueryParams): { query: string, params: any[] } {
  const conditions: string[] = [];
  const queryParams: any[] = [];
  let paramIndex = 1;

  if (params.mainCode) {
    conditions.push(`main_code = ${paramIndex++}`);
    queryParams.push(params.mainCode);
  }

  if (params.srm) {
    conditions.push(`srm = ${paramIndex++}`);
    queryParams.push(params.srm);
  }
  
  if (params.safetyOfficer) {
    conditions.push(`safety_officer = ${paramIndex++}`);
    queryParams.push(params.safetyOfficer);
  }
  
  if (params.projectManager) {
    conditions.push(`project_manager = ${paramIndex++}`);
    queryParams.push(params.projectManager);
  }
  
  if (params.status) {
    conditions.push(`status = ${paramIndex++}`);
    queryParams.push(projectStatus[params.status]);
  }
  
  if (params.commercialOfficer) {
    conditions.push(`commercial_officer = ${paramIndex++}`);
    queryParams.push(params.commercialOfficer);
  }
  
  if (params.vesselName) {
    conditions.push(`vessel_name ILIKE ${paramIndex++}`);
    queryParams.push(`%${params.vesselName}%`);
  }
  
  if (params.arrivalDate) {
    conditions.push(`arrival_date::date = ${paramIndex++}::date`);
    queryParams.push(params.arrivalDate);
  }
  
  if (params.departureDate) {
    conditions.push(`departure_date::date = ${paramIndex++}::date`);
    queryParams.push(params.departureDate);
  }
  
  const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
  
  const query = `
    SELECT *, COUNT(*) OVER() as total_count 
    FROM projects${whereClause}
    ORDER BY ${params.sortBy} ${params.orderBy}
    LIMIT ${paramIndex++} OFFSET ${paramIndex++}
  `;
  queryParams.push(params.limit, params.offset);
  
  return { query, params: queryParams };
}