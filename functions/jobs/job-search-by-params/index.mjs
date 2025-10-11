import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

const jobStatus = {
  Draft: 0,
  Confirmed: 1,
  Cancelled: 2,
  Started: 3,
  Completed: 4
}

const wdrStatusEnum = {
  'Not started': 0,
  Draft: 1,
  'Pre review': 2,
  'HOD review': 3,
  'SRM review': 4,
  Completed: 5
}

const jobTypeEnum = {
  'Main': 0,
  'Support': 1,
  'AWRF': 2,
}

const validSortColumns = {
  title: 'j.title',
  'sub_code_name': 'sub_code_name',
  'trade_section_name': 'trade_section_name',
  'supporting_job': 'j.main_job_id',
  'owner_job_number': 'j.owner_job_number',
  status: 'j.status',
  'wdr_status': 'j.wdr_status',
  'awrf_number': 'j.awrf_number',
  description: 'j.description',
  'plan_start_date': 'j.plan_start_date',
  'plan_complete_date': 'j.plan_complete_date',
  'actual_start_date': 'j.actual_start_date',
  'actual_complete_date': 'j.actual_complete_date',
  'created_date': 'j.created_date',
  'updated_date': 'j.updated_date',
  remark: 'j.remark',
  'actual_process': 'j.progress',
  job_type: 'j.job_type'
};

const ForemanRoleCode = 'FOR';
const TradeSupervisorRoleCode = 'TS';
const HODRoleCode = 'HOD';

const statusNames = Object.fromEntries(
  Object.entries(jobStatus).map(([name, id]) => [id, name])
);

const wdrStatusNames = Object.fromEntries(
  Object.entries(wdrStatusEnum).map(([name, id]) => [id, name])
);

const jobTypeNames = Object.fromEntries(
  Object.entries(jobTypeEnum).map(([name, id]) => [id, name])
);


function getArrayParamFromMultiValueOrQuery(multiValueParams, queryParams, key) {
  if (multiValueParams[key] && multiValueParams[key].length > 0) {
    return multiValueParams[key];
  }
  return queryParams[key] ? [queryParams[key]] : [];
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

function parseQueryParameters(queryParams, multiValueParams) {
  const {
    'search-text': searchText,
    'sort-by': sortBy,
    limit,
    'order-by': orderBy,
    offset,
    'project-id': projectId,
    'no-paging': noPaging,
  } = queryParams || {};

  const type = getArrayParamFromMultiValueOrQuery(multiValueParams, queryParams, 'type');
  let typeValues = [];
  const status = getArrayParamFromMultiValueOrQuery(multiValueParams, queryParams, 'status');
  let statusValues = [];
  const wdrStatus = getArrayParamFromMultiValueOrQuery(multiValueParams, queryParams, 'wdr-status');
  let wdrStatusValues = [];
  const supervisor = getArrayParamFromMultiValueOrQuery(multiValueParams, queryParams, 'supervisor');
  const tradeSectionId = getArrayParamFromMultiValueOrQuery(multiValueParams, queryParams, 'trade-section-id');

  if (projectId && !isValidUUID(projectId)) {
    throw new ValidationError('Invalid project id format');
  }

  if (tradeSectionId.length > 0 && tradeSectionId.some(id => !isValidUUID(id))) {
    throw new ValidationError('Invalid trade section id format');
  }

  if (supervisor.length > 0 && supervisor.some(id => !isValidUUID(id))) {
    throw new ValidationError('Invalid supervisor id format');
  }

  if (type && type.length > 0) {
    typeValues = type.map(t => {
      if (t in jobTypeEnum) {
        return jobTypeEnum[t];
      }
      throw new ValidationError(`Invalid job type value: ${t}`);
    });
  }

  if (status && status.length > 0) {
    statusValues = status.map(s => {
      if (s in jobStatus) {
        return jobStatus[s];
      }
      throw new ValidationError(`Invalid status value: ${s}`);
    });
  }

  if (wdrStatus && wdrStatus.length > 0) {
    wdrStatusValues = wdrStatus.map(s => {
      if (s in wdrStatusEnum) {
        return wdrStatusEnum[s];
      }
      throw new ValidationError(`Invalid status value: ${s}`);
    });
  }

  return {
    searchText, sortBy, limit, orderBy, offset, projectId,
    statusValues, supervisor, tradeSectionId, wdrStatusValues, typeValues,
    noPaging: noPaging === 'true'
  };
}

function buildJobSearchWhereClause(filters) {
  const { searchText, projectId, tradeSectionId, supervisor, statusValues, wdrStatusValues, typeValues } = filters;
  const conditions = [];
  const params = [];
  let paramIndex = 1;
  let searchByAwrf = false;

  if (typeValues && typeValues.length > 0) {
    conditions.push(`j.job_type = ANY($${paramIndex++})`);
    params.push(typeValues);

    if (typeValues.length === 1 && typeValues.includes(jobTypeEnum['AWRF'])) {
      searchByAwrf = true;
    }
  }

  if (searchText && searchText.trim() !== '') {
    if (searchByAwrf) {
      conditions.push(`j.awrf_number ILIKE $${paramIndex++}`);
      params.push(`%${searchText}%`);
    } else {
      conditions.push(`(sc.sub_no ILIKE $${paramIndex++} OR j.owner_job_number ILIKE $${paramIndex++} OR j.title ILIKE $${paramIndex++})`);
      params.push(`%${searchText}%`, `%${searchText}%`, `%${searchText}%`);
    }
  }

  if (projectId) {
    conditions.push(`j.project_id = $${paramIndex++}`);
    params.push(projectId);
  }

  if (tradeSectionId && tradeSectionId.length > 0) {
    conditions.push(`j.trade_section_id = ANY($${paramIndex++})`);
    params.push(tradeSectionId);
  }

  if (supervisor && supervisor.length > 0) {
    conditions.push(`(ptsa.user_id = ANY($${paramIndex++}) AND r.code = ANY($${paramIndex++}))`);
    params.push(supervisor, [ForemanRoleCode, TradeSupervisorRoleCode, HODRoleCode]);
  }

  if (statusValues && statusValues.length > 0) {
    conditions.push(`j.status = ANY($${paramIndex++})`);
    params.push(statusValues);
  }

  if (wdrStatusValues && wdrStatusValues.length > 0) {
    conditions.push(`j.wdr_status = ANY($${paramIndex++})`);
    params.push(wdrStatusValues);
  }

  return { conditions, params, paramIndex };
}

function buildQuery(whereClause, sortBy, orderBy, limit, offset, noPaging) {
  const { conditions, params, paramIndex } = whereClause;
  let whereClausePath = '';
  const countParams = [...params];

  // Main query without assignee aggregation
  let query = `SELECT 
    j.id, j.title, j.sub_code, sc.sub_no as sub_code_name, j.trade_section_id, ts.name as trade_section_name, j.job_type,
    j.main_job_id, j.owner_job_number, j.status, j.wdr_status,
    j.awrf_number, j.description, j.plan_start_date, j.plan_complete_date,
    j.actual_start_date, j.actual_complete_date,
    j.created_date, j.updated_date, j.remark, j.progress
    FROM public.jobs j 
    LEFT JOIN public.trade_sections ts ON ts.id = j.trade_section_id
    LEFT JOIN public.sub_codes sc ON sc.id = j.sub_code
    LEFT JOIN public.project_trade_sections pts ON pts.project_id = j.project_id AND pts.trade_section_id = j.trade_section_id
    LEFT JOIN public.project_trade_section_assigns ptsa ON ptsa.project_trade_section_id = pts.id
    LEFT JOIN public.users u ON u.id = ptsa.user_id
    LEFT JOIN public.roles r ON r.id = ptsa.role_id`;

  let countQuery = `SELECT COUNT(DISTINCT j.id) as total_count FROM public.jobs j 
  LEFT JOIN public.trade_sections ts ON ts.id = j.trade_section_id
  LEFT JOIN public.sub_codes sc ON sc.id = j.sub_code 
  LEFT JOIN public.project_trade_sections pts ON pts.project_id = j.project_id AND pts.trade_section_id = j.trade_section_id
  LEFT JOIN public.project_trade_section_assigns ptsa ON ptsa.project_trade_section_id = pts.id
  LEFT JOIN public.users u ON u.id = ptsa.user_id
  LEFT JOIN public.roles r ON r.id = ptsa.role_id`;

  if (conditions.length > 0) {
    whereClausePath = ' WHERE ' + conditions.join(' AND ');
  }

  query += whereClausePath;
  countQuery += whereClausePath;
  query += ' GROUP BY j.id, sc.sub_no, ts.name';

  const sortColumn = sortBy && sortBy in validSortColumns ? validSortColumns[sortBy] : 'trade_section_name';
  const sortOrder = orderBy ? (orderBy?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC') : 'ASC';

  query += sortColumn === 'j.created_date' ? ` ORDER BY ${sortColumn} ${sortOrder}` : ` ORDER BY ${sortColumn} ${sortOrder}, j.created_date DESC`;

  let limitNum = parseInt(limit, 10) || 10;
  let offsetNum = (parseInt(offset, 10) || 0);

  if (!noPaging) {
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limitNum, offsetNum * limitNum);
  } else {
    limitNum = 0;
    offsetNum = 0;
  }

  return { query, params, countQuery, countParams, limitNum, offsetNum, noPaging };
}

function getJobAssignees(jobIds, supervisorIds = []) {
  if (!jobIds || jobIds.length === 0) return `SELECT '[]'::json as assignees WHERE false`;
  
  if (supervisorIds.length > 0) {
    return `SELECT 
      j.id as job_id,
      COALESCE(
        json_agg(
          json_build_object(
            'name', u.name,
            'role', r.name
          )
          ORDER BY 
            CASE WHEN u.id = ANY($2) THEN 0 ELSE 1 END,
            u.name
        ) FILTER (WHERE u.name IS NOT NULL), '[]'::json
      ) AS assignees
      FROM public.jobs j
      LEFT JOIN public.project_trade_sections pts ON pts.project_id = j.project_id AND pts.trade_section_id = j.trade_section_id
      LEFT JOIN public.project_trade_section_assigns ptsa ON ptsa.project_trade_section_id = pts.id
      LEFT JOIN public.users u ON u.id = ptsa.user_id
      LEFT JOIN public.roles r ON r.id = ptsa.role_id
      WHERE j.id = ANY($1)
      GROUP BY j.id`;
  }
  
  return `SELECT 
    j.id as job_id,
    COALESCE(
      json_agg(
        json_build_object(
          'name', u.name,
          'role', r.name
        )
      ) FILTER (WHERE u.name IS NOT NULL), '[]'::json
    ) AS assignees
    FROM public.jobs j
    LEFT JOIN public.project_trade_sections pts ON pts.project_id = j.project_id AND pts.trade_section_id = j.trade_section_id
    LEFT JOIN public.project_trade_section_assigns ptsa ON ptsa.project_trade_section_id = pts.id
    LEFT JOIN public.users u ON u.id = ptsa.user_id
    LEFT JOIN public.roles r ON r.id = ptsa.role_id
    WHERE j.id = ANY($1)
    GROUP BY j.id`;
}

function calculateJobProgress(job, today) {
  try {
    const planStart = new Date(job.actual_start_date);
    const planComplete = new Date(job.actual_complete_date);

    if (isNaN(planStart) || isNaN(planComplete)) {
      return 0;
    }

    const MILLISECONDS_PER_DAY = 86400000;
    const totalPlanDays = Math.max(1, Math.ceil((planComplete - planStart) / MILLISECONDS_PER_DAY) + 1);
    const trackingDate = planStart > today ? null : (today > planComplete ? planComplete : today);
    const workedDays = trackingDate ? Math.ceil((trackingDate - planStart) / MILLISECONDS_PER_DAY) + 1 : 0;

    return workedDays > 0 ? Math.round((workedDays / totalPlanDays) * 100) : 0;
  } catch (error) {
    console.error('Error calculating job progress:', error);
    return 0;
  }
}

function transformJobData(jobs, assigneeMap) {
  if (!jobs || jobs.length === 0) return [];

  const result = new Array(jobs.length);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const plannedProcess = calculateJobProgress(job, today);

    result[i] = {
      id: job.id,
      title: job.title,
      sub_code: job.sub_code,
      sub_code_name: job.sub_code_name,
      trade_section_id: job.trade_section_id,
      trade_section_name: job.trade_section_name,
      supporting_job: !!job.main_job_id,
      owner_job_number: job.owner_job_number,
      status: statusNames[job.status],
      wdr_status: wdrStatusNames[job.wdr_status],
      job_type: jobTypeNames[job.job_type],
      awrf_number: job.awrf_number,
      description: job.description,
      plan_start_date: job.plan_start_date,
      plan_complete_date: job.plan_complete_date,
      actual_start_date: job.actual_start_date,
      actual_complete_date: job.actual_complete_date,
      assignee: assigneeMap[job.id] || [],
      create_date: job.created_date,
      update_date: job.updated_date,
      remark: job.remark,
      planned_process: plannedProcess,
      actual_process: job.progress ?? 0,
    };
  }

  return result;
}

export const handler = async (event) => {
  try {
    const queryParams = event.queryStringParameters || {};
    const multiValueParams = event.multiValueQueryStringParameters || {};

    const filters = parseQueryParameters(queryParams, multiValueParams);
    const whereClause = buildJobSearchWhereClause(filters);
    const { query, params, countQuery, countParams, limitNum, offsetNum, noPaging } = buildQuery(
      whereClause, filters.sortBy, filters.orderBy, filters.limit, filters.offset, filters.noPaging
    );

    const [result, countResult] = await Promise.all([
      executeQuery(query, params),
      executeQuery(countQuery, countParams)
    ]);

    if (!result.success || !countResult.success) {
      return new LambdaResponse(500, new ApiResponse(false, null, 'Error executing query'));
    }

    // Get assignees separately
    const jobIds = result.data.map(job => job.id);
    const assigneeQuery = getJobAssignees(jobIds, filters.supervisor);
    const assignQueryParams = filters.supervisor && filters.supervisor.length > 0 
      ? [jobIds, filters.supervisor] 
      : jobIds.length > 0 ? [jobIds] : [];
    const assigneeResult = await executeQuery(assigneeQuery, assignQueryParams);
    
    if (!assigneeResult.success) {
      return new LambdaResponse(500, new ApiResponse(false, null, 'Error fetching assignees'));
    }

    // Create assignee map
    const assigneeMap = {};
    assigneeResult.data.forEach(row => {
      assigneeMap[row.job_id] = row.assignees;
    });

    const total = parseInt(countResult.data[0].total_count);
    const responseData = transformJobData(result.data, assigneeMap);

    return new LambdaResponse(200, new ApiResponse(true, {
      pageNumber: noPaging ? null : offsetNum,
      pageSize: noPaging ? null : limitNum,
      totalCount: total,
      data: responseData
    }));
  } catch (error) {
    console.error('Error: ', error);
    if (error instanceof ValidationError) {
      return new LambdaResponse(400, new ApiResponse(false, null, error.message));
    }
    return new LambdaResponse(400, new ApiResponse(false, null, 'Internal server error'));
  }
}