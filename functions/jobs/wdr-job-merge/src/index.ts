import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { executeQuery, performTransaction, Operation, DynamicValue } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES } from 'wdr-error-codes';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

const jobStatus = {
  Draft: 0,
  Confirmed: 1,
  Cancelled: 2,
  Started: 3,
  Completed: 4
};

const WDRStatus = {
  'Not started': 0,
  Draft: 1,
  'Pre review': 2,
  'HOD review': 3,
  'SRM review': 4,
  Completed: 5
};

const projectStatus = {
  'Not started': 0,
  Started: 1,
  Completed: 2,
  Closed: 3
};

const jobTypeEnum = {
  'Main': 0,
  'Support': 1,
  'AWRF': 2
};

const s3Folder = {
  compress: 'compress',
  results: 'results'
};

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

interface JobDataModel {
  trade_section_id: string;
  title: string;
  sub_code: string;
  owner_job_number: string;
  description: string;
  plan_start_date: string;
  plan_complete_date: string;
  actual_start_date: string;
  actual_complete_date: string;
  progress: number;
  remark: string;
  created_date: string;
  created_by: string;
  updated_date: string;
  updated_by: string;
  status: number;
  wdr_status: number;
  project_id: string;
  main_job_id: string | null;
  job_type: number | null;
  awrf_number?: string;
}

interface JobToMerge {
  id: string;
  title: string;
  description: string;
  status: number;
  project_id: string;
  trade_section_id: string;
}

interface ProjectTradeSectionAssigns {
  project_trade_section_id: DynamicValue;
  user_id: string;
  role_id: string;
}

interface MergeJobRequest {
  jobIds: string[];
  description: string;
  title: string;
  tradeSectionId: string;
  subCode: string;
  ownerJobNumber: string;
  projectId: string;
  planStartDate: string;
  planCompleteDate: string;
  actualStartDate: string;
  actualCompleteDate: string;
  remark?: string;
  jobType: string;
  mainJobId?: string;
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // ADD THESE DEBUG LOGS
  console.log('Raw event.body:', event.body);
  console.log('Event body type:', typeof event.body);

  try {
    const body = typeof event?.body === 'string' ? JSON.parse(event.body) : event?.body || {};

    // ADD THIS DEBUG LOG  
    console.log('Parsed body:', JSON.stringify(body, null, 2));
    console.log('body.jobIds:', body.jobIds);
    console.log('body.jobIds type:', typeof body.jobIds);
    console.log('body.jobIds isArray:', Array.isArray(body.jobIds));
    const now = new Date();
    const requestHeader = event?.headers || {};
    const { userId, userName } = getLoginUserInfo(requestHeader);

    const mergeRequest: MergeJobRequest = {
      jobIds: body.jobIds,
      description: body.description,
      title: body.title,
      tradeSectionId: body.tradeSectionId,
      subCode: body.subCode,
      ownerJobNumber: body.ownerJobNumber,
      projectId: body.projectId,
      planStartDate: body.planStartDate,
      planCompleteDate: body.planCompleteDate,
      actualStartDate: body.actualStartDate,
      actualCompleteDate: body.actualCompleteDate,
      remark: body.remark,
      jobType: body.jobType,
      mainJobId: body.mainJobId
    };

    // ADD THIS DEBUG LOG
    console.log('mergeRequest.jobIds:', mergeRequest.jobIds);
    // Validate merge request
    await validateMergeRequest(mergeRequest);

    // Get jobs to merge and validate they are all in Draft status
    const jobsToMerge = await getJobsToMerge(mergeRequest.jobIds);

    // Create merged job data
    const mergedJobData = await createMergedJobData(jobsToMerge, mergeRequest, userId, now);

    // Validate the merged job data
    await validateInput(mergedJobData);
    const assignNewTrade = await validateRelationship(mergedJobData);

    // Prepare transaction operations
    const operations: Operation[] = [];
    let dynamicResultCount = 0;

    // Insert new merged job
    operations.push({
      type: 'insert',
      table: 'jobs',
      data: mergedJobData,
      returningClause: '*'
    });

    // Assign HOD if needed
    if (assignNewTrade) {
      await assignHOD(operations, dynamicResultCount, mergedJobData.project_id, mergedJobData.trade_section_id);
    }

    // Delete original jobs
    mergeRequest.jobIds.forEach(jobId => {
      operations.push({
        type: 'delete',
        table: 'jobs',
        condition: { id: jobId }
      });
    });

    // Execute transaction
    const result = await performTransaction(operations);
    console.log('Merge transaction completed:', result.success ? 'success' : 'failed');

    if (result.success) {
      const mergedJobResult = result.results?.[0][0];

      // Create S3 folders for the new merged job
      const createProjectFolders = [
        `${s3Folder.compress}/${mergedJobData.project_id}/${mergedJobResult.id}/`
      ];
      await invokeFolderCreation(createProjectFolders);

      // DELETE S3 folders for deleted jobs
      const deleteProjectFolders: string[] = [];
      mergeRequest.jobIds.forEach(jobId => {
        deleteProjectFolders.push(
          `${s3Folder.compress}/${mergeRequest.projectId}/${jobId}/`,
          `${s3Folder.results}/${mergeRequest.projectId}/${jobId}/`
        );
      });

      // Invoke folder deletion (fire and forget - don't fail if this fails)
      try {
        await invokeFolderDeletion(deleteProjectFolders);
      } catch (error) {
        // Log error but don't fail the entire operation
        console.error('Failed to delete S3 folders, but job merge was successful:', error);
      }

      return LambdaResponse.success(new ApiResponse(true, {
        mergedJob: mergedJobResult,
        deletedJobIds: mergeRequest.jobIds
      }, 'Jobs merged successfully'));
    }

    return LambdaResponse.error(new ApiResponse(false, null, 'Job merge failed!', result.success !== undefined ? result.error : result));

  } catch (error: any) {
    console.error('Job merge error:', error.name || 'Unknown error');
    if (error.name === 'ValidationError') {
      return LambdaResponse.error(new ApiResponse(false, null, error.message, ERROR_CODES.INVALID_REQUEST.code));
    } else {
      return LambdaResponse.error(new ApiResponse(false, null, 'Internal server error', ERROR_CODES.INVALID_REQUEST.code));
    }
  }
};

async function validateMergeRequest(mergeRequest: MergeJobRequest) {
  // Validate job IDs array
  if (!mergeRequest.jobIds || !Array.isArray(mergeRequest.jobIds) || mergeRequest.jobIds.length < 2) {
    throw new ValidationError('At least 2 jobs are required for merging');
  }

  // Validate each job ID is a valid UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const jobId of mergeRequest.jobIds) {
    if (!uuidRegex.test(jobId)) {
      throw new ValidationError(`Invalid job ID format: ${jobId}`);
    }
  }

  // Validate other required fields
  if (!mergeRequest.tradeSectionId || !uuidRegex.test(mergeRequest.tradeSectionId)) {
    throw new ValidationError('Trade section ID is required and must be valid UUID');
  }

  if (!mergeRequest.subCode || !uuidRegex.test(mergeRequest.subCode)) {
    throw new ValidationError('Sub code is required and must be valid UUID');
  }

  if (!mergeRequest.ownerJobNumber) {
    throw new ValidationError('Owner job number is required');
  }

  if (!mergeRequest.projectId || !uuidRegex.test(mergeRequest.projectId)) {
    throw new ValidationError('Project ID is required and must be valid UUID');
  }

  if (!mergeRequest.jobType || !(mergeRequest.jobType in jobTypeEnum)) {
    throw new ValidationError('Job type is required and must be valid');
  }
}

async function getJobsToMerge(jobIds: string[]): Promise<JobToMerge[]> {
  const placeholders = jobIds.map((_, index) => `$${index + 1}`).join(',');
  const query = `
    SELECT id, title, description, status, project_id, trade_section_id 
    FROM jobs 
    WHERE id IN (${placeholders})
  `;

  const result = await executeQuery(query, jobIds);
  console.log('Jobs to merge query completed:', result.success ? 'success' : 'failed');

  if (!result.success) {
    throw new ValidationError('Failed to retrieve jobs to merge');
  }

  if (result.data.length !== jobIds.length) {
    throw new ValidationError('Some jobs were not found');
  }

  // Validate all jobs are in Draft status
  const nonDraftJobs = result.data.filter((job: JobToMerge) => job.status !== jobStatus.Draft);
  if (nonDraftJobs.length > 0) {
    throw new ValidationError('All jobs must be in Draft status to be merged');
  }

  // Validate all jobs belong to the same project
  const projectIds = [...new Set(result.data.map((job: JobToMerge) => job.project_id))];
  if (projectIds.length > 1) {
    throw new ValidationError('All jobs must belong to the same project');
  }

  return result.data;
}

async function createMergedJobData(jobsToMerge: JobToMerge[], mergeRequest: MergeJobRequest, userId: string, now: Date): Promise<JobDataModel> {
  // Concatenate titles and descriptions with hyphen
  // const mergedTitle = jobsToMerge.map((job: JobToMerge) => job.title).join(' - ');
  // const mergedDescription = jobsToMerge.map((job: JobToMerge) => job.description || '').filter(desc => desc.length > 0).join(' - ');

  const jobData: JobDataModel = {
    trade_section_id: mergeRequest.tradeSectionId,
    title: mergeRequest.title,
    sub_code: mergeRequest.subCode,
    owner_job_number: mergeRequest.ownerJobNumber,
    description: mergeRequest.description,
    plan_start_date: mergeRequest.planStartDate,
    plan_complete_date: mergeRequest.planCompleteDate,
    actual_start_date: mergeRequest.actualStartDate,
    actual_complete_date: mergeRequest.actualCompleteDate,
    progress: 0,
    remark: mergeRequest.remark || '',
    created_date: now.toISOString(),
    created_by: userId,
    updated_date: now.toISOString(),
    updated_by: userId,
    status: jobStatus.Draft, // Merged job starts as Draft
    wdr_status: WDRStatus['Not started'],
    project_id: mergeRequest.projectId,
    main_job_id: mergeRequest.mainJobId || null,
    job_type: (mergeRequest.jobType && typeof mergeRequest.jobType === 'string' && mergeRequest.jobType in jobTypeEnum)
      ? jobTypeEnum[mergeRequest.jobType as keyof typeof jobTypeEnum]
      : null
  };

  return jobData;
}

async function assignHOD(operations: Operation[], dynamicResultCount: number, project_id: string, trade_section_id: string) {
  operations.push({
    type: 'insert',
    table: 'project_trade_sections',
    data: {
      project_id: project_id,
      trade_section_id: trade_section_id,
    },
    returningClause: '*'
  });
  dynamicResultCount += 1;

  const selectHODQuery = `SELECT uts.user_id, uts.role_id FROM user_trade_sections uts JOIN roles r ON r.id = uts.role_id 
      WHERE uts.trade_section_id = $1 AND r.code = $2`;
  const selectHODParams = [trade_section_id, headOfDepartmentCode];
  const hodResult = await executeQuery(selectHODQuery, selectHODParams);
  console.log('HOD query completed:', hodResult.success ? 'success' : 'failed');

  if (hodResult.success && 'data' in hodResult && Array.isArray(hodResult.data)) {
    if (hodResult.data.length > 0) {
      hodResult.data.map((hod: { user_id: string; role_id: string }) => {
        const projectTradeSectionAssigns: ProjectTradeSectionAssigns = {
          project_trade_section_id: {
            type: 'dynamic_result',
            fromIndex: dynamicResultCount,
            field: 'id'
          },
          user_id: hod.user_id,
          role_id: hod.role_id,
        };
        operations.push({
          type: 'insert',
          table: 'project_trade_section_assigns',
          data: projectTradeSectionAssigns
        });
      });
    } else {
      console.log('No HOD found for the trade section');
    }
  }

  if (!hodResult.success) {
    throw new ValidationError('Error retrieving HOD for the trade section');
  }
}

function isDateValid(dateString: string): boolean {
  if (!dateString || typeof dateString !== 'string') {
    return false;
  }
  const date = new Date(dateString);
  return !isNaN(date.getTime()) && dateString.length >= 10;
}

function isValidUUID(uuid: string) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

async function validateInput(jobData: JobDataModel) {
  // Validate trade section
  if (!jobData.trade_section_id || !isValidUUID(jobData.trade_section_id)) {
    throw new ValidationError('Trade section id is not valid');
  }

  // Validate required field
  if (!jobData.title) {
    throw new ValidationError('Title is required');
  }

  if (!jobData.sub_code || !isValidUUID(jobData.sub_code)) {
    throw new ValidationError('Sub code is not valid');
  }

  if (!jobData.owner_job_number) {
    throw new ValidationError('Owner job number is required');
  }

  if (jobData.job_type === undefined || jobData.job_type === null) {
    throw new ValidationError('Job type is required');
  }

  // Validate project
  if (!jobData.project_id || !isValidUUID(jobData.project_id)) {
    throw new ValidationError('Project id is not valid');
  }

  // Validate date
  if (!jobData.plan_start_date || !isDateValid(jobData.plan_start_date)) {
    throw new ValidationError('Plan start date is not valid');
  }

  if (!jobData.plan_complete_date || !isDateValid(jobData.plan_complete_date)) {
    throw new ValidationError('Plan complete date is not valid');
  }

  if (jobData.actual_start_date && !isDateValid(jobData.actual_start_date)) {
      throw new ValidationError('Actual start date is not valid');
  }

  if (jobData.actual_complete_date && !isDateValid(jobData.actual_complete_date)) {
      throw new ValidationError('Actual complete date is not valid');
  }
  // Validate date ranges
  if (new Date(jobData.plan_start_date) > new Date(jobData.plan_complete_date)) {
    throw new ValidationError('Plan start date cannot be after plan complete date');
  }

  if (jobData.actual_start_date && jobData.actual_complete_date && 
      new Date(jobData.actual_start_date) > new Date(jobData.actual_complete_date)) {
      throw new ValidationError('Actual start date cannot be after actual complete date');
  }
}

async function validateRelationship(jobData: JobDataModel) {
  // Validate trade_section, sub_code, and job title in single query
  const validationSql = `
      WITH validation AS (
        SELECT 
          (SELECT name FROM trade_sections WHERE id = $1) as trade_section_name,
          (SELECT EXISTS(SELECT 1 FROM sub_codes WHERE id = $2)) as sub_code_exists,
          (SELECT EXISTS(SELECT 1 FROM jobs WHERE title = $4 AND project_id = $3)) as job_title_exists
      )
      SELECT * FROM validation
    `;
  const validationResult = await executeQuery(validationSql, [jobData.trade_section_id, jobData.sub_code, jobData.project_id, jobData.title]);
  console.log('Validation query completed:', validationResult.success ? 'success' : 'failed');

  if (!validationResult.success) {
    throw new ValidationError('Error validating job data');
  }

  const validation = validationResult.data[0];

  if (!validation.trade_section_name) {
    throw new ValidationError('Trade section id is not valid');
  }

  if (!validation.sub_code_exists) {
    throw new ValidationError('Sub code is not valid');
  }

  if (validation.job_title_exists) {
    throw new ValidationError('Job with this title already exists in the project');
  }

  const tradeSectionName = validation.trade_section_name;

  // Validate project and check trade assignment
  let assignNewTrade = false;
  const projectSql = `SELECT array_agg(pts.trade_section_id) AS assigned_trades 
                    FROM projects p 
                    LEFT JOIN project_trade_sections pts ON pts.project_id = p.id 
                    WHERE p.id = $1 
                    GROUP BY p.id`;
  const projectParams = [jobData.project_id];
  const projectResult = await executeQuery(projectSql, projectParams);

  console.log('Project query completed:', projectResult.success ? 'success' : 'failed');
  if (!projectResult.success) {
    throw new ValidationError('Error validating project data');
  }

  if (projectResult.data && projectResult.data.length > 0) {
    const projectData = projectResult.data[0];

    // Chỉ kiểm tra trade assignment để quyết định có cần assign HOD không
    if (!projectData.assigned_trades || !projectData.assigned_trades.includes(jobData.trade_section_id)) {
      assignNewTrade = true;
    }
  } else {
    throw new ValidationError('Project id is not valid');
  }

  // Validate main job in case supporting or assist job
  if (jobData.job_type !== jobTypeEnum['Main']) {
    if (!jobData.main_job_id) {
      if (jobTypeEnum['Support'] === jobData.job_type) {
        throw new ValidationError('Main job id is required');
      }
    } else {
      if (!isValidUUID(jobData.main_job_id)) {
        throw new ValidationError('Main job id is not valid');
      }

      const allowedJobTypes = jobData.job_type === jobTypeEnum['AWRF']
        ? [jobTypeEnum['Main'], jobTypeEnum['Support']]
        : [jobTypeEnum['Main']];

      const mainJobSql = `SELECT status FROM jobs WHERE id = $1 AND job_type = ANY($2)`;
      const mainJobParams = [jobData.main_job_id, allowedJobTypes];

      const mainJobResult = await executeQuery(mainJobSql, mainJobParams);
      console.log('Main job query completed:', mainJobResult.success ? 'success' : 'failed');

      if (!mainJobResult.success || mainJobResult.rowCount === 0) {
        throw new ValidationError('Main job id is not valid');
      }

      const mainJob = mainJobResult.data[0];
      if (jobTypeEnum['Support'] === jobData.job_type && mainJob.status === jobStatus['Cancelled']) {
        throw new ValidationError('Cannot create supporting job for a cancelled job');
      }
    }
  } else {
    jobData.main_job_id = null;
  }

  if (jobData.job_type === jobTypeEnum['AWRF']) {
    const awrdCountResult = await executeQuery('SELECT COUNT(*) + 1 as next_number FROM jobs WHERE project_id = $1 AND job_type = $2', [jobData.project_id, jobTypeEnum['AWRF']]);
    if (!awrdCountResult.success) {
      throw new ValidationError('Error when count assist job');
    }

    jobData.awrf_number = `AWRF-${tradeSectionName[0]}-${awrdCountResult.data[0].next_number}`;
  }

  return assignNewTrade;
}

async function invokeFolderCreation(createProjectFolders: string[]) {
  const functionName = process.env.BUCKET_CREATE_FOLDER_FUNCTION_NAME;

  if (!functionName) {
    console.error('BUCKET_CREATE_FOLDER_FUNCTION_NAME environment variable not set');
    throw new Error('Missing required environment variable');
  }

  console.log('Invoking folder creation Lambda');
  console.log('Folder count:', createProjectFolders.length);

  try {
    const command = new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({ folders: createProjectFolders })
    });

    const response = await lambdaClient.send(command);
    console.log('Lambda invocation completed successfully');
  } catch (error: any) {
    console.error('Failed to invoke folder creation Lambda:', error.name || 'Unknown error');
    throw new Error('Folder creation failed');
  }
}

async function invokeFolderDeletion(deleteProjectFolders: string[]) {
  const functionName = process.env.BUCKET_DELETE_FOLDER_FUNCTION_NAME;

  if (!functionName) {
    console.error('BUCKET_DELETE_FOLDER_FUNCTION_NAME environment variable not set');
    throw new Error('Missing required environment variable');
  }

  console.log('Invoking folder deletion Lambda');
  console.log('Folder count:', deleteProjectFolders.length);

  try {
    const command = new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({ folders: deleteProjectFolders })
    });

    const response = await lambdaClient.send(command);
    console.log('Lambda deletion invocation completed successfully');
  } catch (error: any) {
    console.error('Failed to invoke folder deletion Lambda:', error.name || 'Unknown error');
    throw new Error('Folder deletion failed');
  }
}