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

    if (queryParams.arrivalDate && isNaN(Date.parse(queryParams.arrivalDate))) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid arrivalDate format'));
    }

    if (queryParams.departureDate && isNaN(Date.parse(queryParams.departureDate))) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid departureDate format'));
    }

    if (queryParams.status && !(queryParams.status in projectStatus)) {
      return new LambdaResponse(400, new ApiResponse(false, null, `Invalid status value. Allowed: ${Object.keys(projectStatus).join(', ')}`));
    }
    
    const { query, params, conditions } = buildQuery(queryParams);
    
    console.log('Query: ', query);
    console.log('Params: ', params);

    // Execute query
    const result = await executeQuery(query, params);

    console.log('Result: ', result);

    if (!result.success) {
      return new ApiResponse(false, null, 'Error executing query', result.error);
    }

    // Get total count for pagination
    const countQuery = 'SELECT COUNT(*) as total FROM projects' + 
      (conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '');

    const countResult = await executeQuery(countQuery, params.slice(0, -2));

    if (!countResult.success) {
      return new LambdaResponse(500, new ApiResponse(false, null, 'Error executing count query', result.error));
    }

    const total = parseInt(countResult.data[0].total, 10);

    return new ResponsePage(queryParams.offset, queryParams.limit, total, result.data);
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};

function parseQueryParameters(params: Record<string, any>): QueryParams {
  const validSortColumns: SortColumn[] = ['create_date', 'arrival_date', 'departure_date', 'vessel_name', 'status'];
  const sortBy = params['sort-by'];
  
  return {
    mainCode: params['main-code'],
    srm: params.srm,
    safetyOfficer: params['safety-officer'],
    projectManager: params['project-manager'],
    status: params.status as ProjectStatus,
    commercialOfficer: params['commercial-officer'],
    vesselName: params['vessel-name'],
    arrivalDate: params['arrival-date'],
    departureDate: params['departure-date'],
    sortBy: validSortColumns.includes(sortBy as SortColumn) ? sortBy as SortColumn : 'create_date',
    orderBy: params['order-by']?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
    limit: parseInt(params.limit, 10) || 10,
    offset: parseInt(params.offset, 10) || 0
  };
}

function buildQuery(params: QueryParams): { query: string, params: any[], conditions: string[] } {
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
  
  // Build the query
  let query = 'SELECT * FROM projects';
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  // Add sorting
  query += ` ORDER BY ${params.sortBy} ${params.orderBy}`;
  
  // Add pagination
  query += ` LIMIT ${paramIndex++} OFFSET ${paramIndex++}`;
  queryParams.push(params.limit, params.offset);
  
  return { query, params: queryParams, conditions };
}