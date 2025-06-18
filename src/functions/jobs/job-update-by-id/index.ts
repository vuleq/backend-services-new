import { updateRecord, executeQuery } from '/opt/nodejs/db';
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

interface JobUpdateBody {
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
  progress?: string | number; // Can be provided as string or number
  remark?: string;
  status?: JobStatusKey;
  projectId?: string; // Used only for validation, not for updates
  mainJobId?: string; // Used only for validation, not for updates
  isWDR?: boolean
}

export const handler = async (event: any) => {
  console.log('Receive event', event);

  try {
    const jobId = event.pathParameters?.id;
    if (!jobId) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Job ID is required'));
    }
    
    let body: JobUpdateBody = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (err) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid JSON in request body'));
    }
    
    // Sanitize string inputs but preserve empty strings
    Object.keys(body).forEach(key => {
      const value = (body as any)[key];
      if (typeof value === 'string') {
        // Trim but don't convert empty strings to undefined
        (body as any)[key] = value.trim();
      }
    });
    const now = new Date();

    // Validate status if provided
    let jobStatusValue;
    if (body.status !== undefined) {
      if (!(body.status in jobStatus)) {
        return new LambdaResponse(400, new ApiResponse(false, null, `Invalid status value. Allowed: ${Object.keys(jobStatus).join(', ')}`));
      }
      jobStatusValue = jobStatus[body.status as JobStatusKey];
    }
    
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
    
    const jobData: Record<string, any> = {
      update_date: now.toISOString(),
    };
    
    // Only include fields that are allowed to be updated
    if (body.tradeSectionId !== undefined) jobData.trade_section_id = body.tradeSectionId || null;
    if (body.sn !== undefined) jobData.s_n = body.sn;
    if (body.subCode !== undefined) jobData.sub_code = body.subCode;
    if (body.ownerJobNumber !== undefined) jobData.owner_job_number = body.ownerJobNumber;
    if (body.awrfNumber !== undefined) jobData.awrf_number = body.awrfNumber;
    if (body.title !== undefined) jobData.title = body.title;
    if (body.description !== undefined) jobData.description = body.description;
    if (body.planStartDate !== undefined) jobData.plan_start_date = body.planStartDate;
    if (body.planCompleteDate !== undefined) jobData.plan_complete_date = body.planCompleteDate;
    if (body.actualStartDate !== undefined) jobData.actual_start_date = body.actualStartDate;
    if (body.actualCompleteDate !== undefined) jobData.actual_complete_date = body.actualCompleteDate;
    if (body.supervisor !== undefined) jobData.supervisor = body.supervisor;
    // Handle progress as integer (0-100)
    if (body.progress !== undefined) {
      // Convert to number if it's a string
      const progressValue = typeof body.progress === 'string' ? parseInt(body.progress, 10) : body.progress;
      
      // Validate progress is a number between 0-100
      if (isNaN(progressValue as number)) {
        return new LambdaResponse(400, new ApiResponse(false, null, 'Progress must be a number', null));
      }
      
      if (progressValue < 0 || progressValue > 100) {
        return new LambdaResponse(400, new ApiResponse(false, null, 'Progress must be between 0 and 100', null));
      }
      
      jobData.progress = progressValue;
    }
    if (body.remark !== undefined) jobData.remark = body.remark;
    if (body.status !== undefined) jobData.status = jobStatusValue;
    if (body.isWDR !== undefined) jobData.is_wdr = body.isWDR;
    
    // Note: projectId and mainJobId are not included as they cannot be updated

    console.log('Job Data:', jobData);

    const currentJobSql = `SELECT * FROM jobs WHERE id = $1`;
    const currentJobParams = [jobId];
    const currentJobResult = await executeQuery(currentJobSql, currentJobParams);

    if (!currentJobResult.success || currentJobResult.rowCount === 0) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid Job id', null));
    }

    const currentJob = currentJobResult.data[0];
    console.log('Current Job:', currentJob);
    if (currentJob.status === jobStatus['WDR COMPLETED'] || currentJob.status ===  jobStatus['WDR DRAFT']) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Cannot update a job with WDR COMPLETED or WDR DRAFT status', null));
    }

    // If mainJobId or projectId are provided, verify they match the current values
    // These are included only for validation, not for updates
    if (body.mainJobId !== undefined && currentJob.main_job_id !== body.mainJobId) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Changing the main job is not allowed', null));
    }

    if (body.projectId !== undefined && currentJob.project_id !== body.projectId) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Changing the project is not allowed', null));
    }
    
    // If no fields to update, return early
    if (Object.keys(jobData).length <= 1) { // Only update_date is present
      return new LambdaResponse(400, new ApiResponse(false, null, 'No valid fields to update were provided', null));
    }
    
    // Validate title if it's being updated - empty string is not allowed
    if (jobData.title !== undefined && jobData.title === '') {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Job title cannot be empty', null));
    }

    const result = await updateRecord('jobs', jobData, {id : jobId});
    console.log('Result:', result);

    if (result.success) {
      return new LambdaResponse(200, new ApiResponse(true, result.data, 'Job updated successfully'));
    }

    return new LambdaResponse(400, new ApiResponse(false, null, 'Job updated failed!', result.error));
    
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

// Validate date fields
const validateDate = (dateField: string | undefined, fieldName: string): boolean => {
    if (dateField && isNaN(Date.parse(dateField))) {
    throw new Error(`Invalid ${fieldName} format. Use YYYY-MM-DD format.`);
    }
    return true;
};