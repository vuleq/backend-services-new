import { insertRecord, executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

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

const projectStatus = {
  'Not Start': 0,
  Started: 1,
  Completed: 2,
  Closed: 3
} as const;

interface JobCreateBody {
  tradeSectionId?: string;
  sn?: string;
  subCode?: string;
  ownerJobNumber?: string;
  awrfNumber?: string;
  title?: string;
  description?: string;
  planStartDate?: string;
  planCompleteDate?: string;
  actualStartDate?: string;
  actualCompleteDate?: string;
  supervisor?: string;
  progress?: string;
  remark?: string;
  status?: JobStatusKey;
  projectId?: string;
  mainJobId?: string;
}

export const handler = async (event: any) => {
  console.log('Receive event', event);

  try {
    const now = new Date();
    // Parse and validate request body
    let body: JobCreateBody = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (err) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid JSON in request body'));
    }
    
    // Validate required fields
    if (!body.projectId) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Project ID is required'));
    }
    
    if (!body.title) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Job title is required'));
    }
    
    // Sanitize string inputs
    Object.keys(body).forEach(key => {
      const value = (body as any)[key];
      if (typeof value === 'string') {
        (body as any)[key] = value.trim();
      }
    });
    
    try {
      // Validate date formats
      validateDate(body.planStartDate, 'planStartDate');
      validateDate(body.planCompleteDate, 'planCompleteDate');
      validateDate(body.actualStartDate, 'actualStartDate');
      validateDate(body.actualCompleteDate, 'actualCompleteDate');
      
      // Validate date ranges
      if (body.planStartDate && body.planCompleteDate) {
        if (new Date(body.planStartDate) > new Date(body.planCompleteDate)) {
          return new LambdaResponse(400, new ApiResponse(false, null, 'Plan start date cannot be after plan complete date'));
        }
      }
      
      if (body.actualStartDate && body.actualCompleteDate) {
        if (new Date(body.actualStartDate) > new Date(body.actualCompleteDate)) {
          return new LambdaResponse(400, new ApiResponse(false, null, 'Actual start date cannot be after actual complete date'));
        }
      }
    } catch (error: any) {
      return new LambdaResponse(400, new ApiResponse(false, null, error.message));
    }
    
    // Set default status if not provided
    const status = body.status ? jobStatus[body.status] : null;
    
    const jobData = {
      trade_section_id: body.tradeSectionId,
      s_n: body.sn || null,
      sub_code: body.subCode || null,
      owner_job_number: body.ownerJobNumber || null,
      awrf_number: body.awrfNumber || null,
      title: body.title,
      description: body.description || null,
      plan_start_date: body.planStartDate || null,
      plan_complete_date: body.planCompleteDate || null,
      actual_start_date: body.actualStartDate || null,
      actual_complete_date: body.actualCompleteDate || null,
      supervisor: body.supervisor || null,
      progress: body.progress || null,
      remark: body.remark || null,
      create_date: now.toISOString(),
      update_date: now.toISOString(),
      status: status,
      project_id: body.projectId,
      main_job_id: body.mainJobId || null,
      is_wdr: true
    };

    console.log('Job Data:', jobData);

    const sql = `SELECT * FROM projects WHERE id = $1`;
    const params = [body.projectId];
    const projectResult = await executeQuery(sql, params);
    console.log('Project Result:', projectResult);

    if (!projectResult.success  || projectResult.rowCount === 0) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid Project id', null));
    }

    const project = projectResult.data[0];
    if (project.status === projectStatus['Completed'] || project.status === projectStatus['Closed']) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Not allow to create job in finished project', null));
    }

    if (body.mainJobId) {
      const mainJobSql = `SELECT * FROM jobs WHERE id = $1`;
      const mainJobParams = [body.mainJobId];
      const mainJobResult = await executeQuery(mainJobSql, mainJobParams);
      console.log('Main Job Result:', mainJobResult);

      if (!mainJobResult.success || mainJobResult.rowCount === 0) {
        return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid Main Job id', null));
      }

      const mainJob = mainJobResult.data[0];
      if (mainJob.status === jobStatus['CANCELLED'] || mainJob.status === jobStatus['WDR DRAFT'] || mainJob.status === jobStatus['WDR COMPLETED']) {
        return new LambdaResponse(400, new ApiResponse(false, null, 'Cannot create sub-job for a cancelled or completed job', null));
      }
    }

    const result = await insertRecord('jobs', jobData);
    console.log('Result:', result);

    if (result.success && typeof (result as any).rowCount === 'number' && (result as any).rowCount > 0) {
      return new LambdaResponse(201, new ApiResponse(true, (result as any).data, 'Job created successfully'));
    }

    return new LambdaResponse(400, new ApiResponse(false, null, 'Job creation failed', (result as any).error ?? (result as any).message ?? result));
    
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};

// Validate date fields
const validateDate = (dateField: string | undefined, fieldName: string): boolean => {
    if (dateField && isNaN(Date.parse(dateField))) {
    throw new Error(`Invalid ${fieldName} format. Use YYYY-MM-DD format.`);
    }
    return true;
};