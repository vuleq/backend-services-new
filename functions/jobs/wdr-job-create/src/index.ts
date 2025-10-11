import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery, performTransaction, Operation, DynamicValue } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES, ValidationError, DataBaseError } from 'wdr-error-codes';
import { isValidUUID, isValidCognitoSub, getLoginUserInfo } from 'wdr-common-utils';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
const s3 = new S3Client({ region: process.env.AWS_REGION });

const jobStatus = {
  Draft: 0,
  Confirmed: 1,
  Cancelled: 2,
  Started: 3,
  Completed: 4
}

const WDRStatus = {
  'Not started': 0,
  Draft: 1,
  'Pre review': 2,
  'HOD review': 3,
  'SRM review': 4,
  Completed: 5
}

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
}

enum ProjectRole {
  SU = 0,
  SRM
}

const s3Folder = {
  compress: 'compress', // All upload image are compress to this folder
  results: 'results' // Current only store project quotation result file
}

const headOfDepartmentCode = 'HOD';

interface JobDataModel {
  trade_section_id: string;
  title: string;
  sub_code: string;
  owner_job_number: string;
  description: string;
  plan_start_date: string;
  plan_complete_date: string;
  actual_start_date: string | null;
  actual_complete_date: string | null;
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

interface ProjectTradeSectionAssigns {
  project_trade_section_id: DynamicValue;
  user_id: string;
  role_id: string;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Processing job creation request');

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
    const now = new Date();
    const requestHeader = event.headers;
    const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

    if (!loginUserId || !isValidCognitoSub(loginUserId)) {
      return LambdaResponse.error(new ApiResponse(false, null, 'User data not valid'));
    }

    const jobData: JobDataModel = {
      trade_section_id: body.tradeSectionId,
      title: typeof body.title === 'string' ? body.title.trim() : body.title,
      sub_code: body.subCode,
      owner_job_number: body.ownerJobNumber,
      description: body.description,
      plan_start_date: body.planStartDate,
      plan_complete_date: body.planCompleteDate,
      actual_start_date: body.actualStartDate,
      actual_complete_date: body.actualCompleteDate,
      progress: 0,
      remark: body.remark,
      created_date: now.toISOString(),
      created_by: loginUserId,
      updated_date: now.toISOString(),
      updated_by: loginUserId,
      status: jobStatus.Draft,
      wdr_status: WDRStatus['Not started'],
      project_id: body.projectId,
      main_job_id: body.mainJobId,
      job_type: (body.jobType && typeof body.jobType === 'string' && body.jobType in jobTypeEnum) ? jobTypeEnum[body.jobType as keyof typeof jobTypeEnum] : null
    };

    const hasAccess = await isUserAllowToCreateJob(loginUserId, jobData.project_id);
    if (!hasAccess) {
      return new LambdaResponse(403, new ApiResponse(false, null, 'User do not has permission to create job'));
    }

    await validateInput(jobData);

    const { assignNewTrade, tradeSectionName } = await validateRelationship(jobData);

    const operations: Operation[] = [];
    let dynamicResultCount = 0;
    operations.push({
      type: 'insert',
      table: 'jobs',
      data: jobData,
      returningClause: '*'
    });

    if (assignNewTrade) {
      await assignHOD(operations, dynamicResultCount, jobData.project_id, jobData.trade_section_id);
    }

    if (jobData.job_type === jobTypeEnum['AWRF']) {
      await handleAWRFNumber(jobData, tradeSectionName, operations);
    }

    const result = await performTransaction(operations);
    console.log('Transaction completed:', result.success ? 'success' : 'failed');

    if (result.success) {
      const jobAddedResult = result.results?.[0][0];
      const createProjectFolders = [`${s3Folder.compress}/${jobData.project_id}/${jobAddedResult.id}/`];
      await invokeFolderCreation(createProjectFolders);
      return LambdaResponse.success(new ApiResponse(true, jobAddedResult, 'Job created successfully'));
    }

    return LambdaResponse.error(new ApiResponse(false, null, 'Job created failed!', result.success !== undefined ? result.error : result));

  } catch (error: any) {
    console.error('Job creation error:', JSON.stringify(error));
    if (error instanceof ValidationError) {
      return LambdaResponse.error(new ApiResponse(false, null, error.message, ERROR_CODES.INVALID_REQUEST.code));
    } else if (error instanceof DataBaseError) {
      return LambdaResponse.error(new ApiResponse(false, null, error.message, ERROR_CODES.DATABASE_ERROR.code));
    } else {
      return LambdaResponse.error(new ApiResponse(false, null, 'Internal server error', ERROR_CODES.INVALID_REQUEST.code));
    }
  }

};

async function handleAWRFNumber(jobData: JobDataModel, tradeSectionName: string, operations: Operation[]) {
  let nextAWRFNumber = await getNextAWRFNumber(jobData);
  jobData.awrf_number = `AWRF-${tradeSectionName[0]}-${nextAWRFNumber}`;

  if (nextAWRFNumber === 1) {
    operations.push({
      type: 'insert',
      table: 'awrf_number_tracking',
      data: {
        project_id: jobData.project_id,
        trade_section_id: jobData.trade_section_id,
        tracking_number: nextAWRFNumber
      }
    });
  } else {
    operations.push(
      {
        type: 'update',
        table: 'awrf_number_tracking',
        data: {
          tracking_number: nextAWRFNumber
        },
        condition: {
          project_id: jobData.project_id,
          trade_section_id: jobData.trade_section_id
        }
      }
    );
  }
}

async function isUserAllowToCreateJob(userId: string, projectId: string) {
  // Only Super User and SRM can create job
  const checkProjectRoleResult = await executeQuery(
    `SELECT EXISTS (SELECT 1 FROM project_assignments pa WHERE pa.user_id = $1 AND pa.project_id = $2 AND pa.role = ANY($3))`,
    [userId, projectId, [ProjectRole.SU, ProjectRole.SRM]]
  );

  if (!checkProjectRoleResult.success) {
    console.error('Failed to check project role');
    return false;
  }

  return checkProjectRoleResult.data[0].exists;
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
    throw new DataBaseError('Error retrieving HOD for the trade section');
  }
}

function isDateValid(dateString: string): boolean {
  if (!dateString || typeof dateString !== 'string') {
    return false;
  }
  const date = new Date(dateString);
  return !isNaN(date.getTime()) && dateString.length >= 10;
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

  if (jobData.actual_start_date && jobData.actual_complete_date && new Date(jobData.actual_start_date) > new Date(jobData.actual_complete_date)) {
    throw new ValidationError('Actual start date cannot be after actual complete date');
  }
}

async function validateRelationship(jobData: JobDataModel) {
  // Validate trade_section, sub_code in single query
  const validationSql = `
      WITH validation AS (
        SELECT 
          (SELECT name FROM trade_sections WHERE id = $1) as trade_section_name,
          (SELECT EXISTS(SELECT 1 FROM sub_codes WHERE id = $2 AND project_id = $3)) as sub_code_exists
      )
      SELECT * FROM validation
    `;
  const validationResult = await executeQuery(validationSql, [jobData.trade_section_id, jobData.sub_code, jobData.project_id]);
  console.log('Validation query completed:', validationResult.success ? 'success' : 'failed');

  if (!validationResult.success) {
    throw new DataBaseError('Error validating job data');
  }

  const validation = validationResult.data[0];

  if (!validation.trade_section_name) {
    throw new ValidationError('Trade section id is not valid');
  }

  if (!validation.sub_code_exists) {
    throw new ValidationError('Sub code is not valid');
  }

  const tradeSectionName = validation.trade_section_name;

  // Validate project
  let assignNewTrade = await validateProject(jobData);

  // Validate main job in case supporting or assist job
  if (jobData.job_type !== jobTypeEnum['Main']) {
    await validateSupportAndAWRFJob(jobData);
  } else {
    await validateJobTitle(jobData);
    jobData.main_job_id = null;
  }

  return { assignNewTrade, tradeSectionName };
}

async function validateJobTitle(jobData: JobDataModel) {
  const checkTitleJobSql = `SELECT EXISTS(SELECT 1 FROM jobs WHERE title = $1 AND project_id = $2 AND trade_section_id = $3)`;
  const checkTitleJobParams = [jobData.title, jobData.project_id, jobData.trade_section_id];
  const checkTitleJobResult = await executeQuery(checkTitleJobSql, checkTitleJobParams);

  console.log('Job title query completed:', checkTitleJobResult.success ? 'success' : 'failed');
  if (!checkTitleJobResult.success) {
    throw new DataBaseError('Error validating job title');
  }

  if (checkTitleJobResult.data[0].exists) {
    throw new ValidationError('Job title already exists in this trade section');
  }
}

async function validateProject(jobData: JobDataModel) {
  const projectSql = `SELECT p.status, array_agg(pts.trade_section_id) AS assigned_trades FROM projects p 
  LEFT JOIN project_trade_sections pts ON pts.project_id = p.id WHERE p.id = $1 GROUP BY p.status`;
  const projectParams = [jobData.project_id];
  const projectResult = await executeQuery(projectSql, projectParams);

  console.log('Project query completed:', projectResult.success ? 'success' : 'failed');
  if (!projectResult.success) {
    throw new DataBaseError('Error validating project data');
  }

  if (projectResult.data) {
    const projectData = projectResult.data[0];
    if (!projectData) {
      throw new ValidationError('Project id is not valid');
    }

    if (projectData.status !== projectStatus['Not started'] && projectData.status !== projectStatus['Started']) {
      throw new ValidationError('Project is not in a valid state to create job');
    }

    if (!projectData.assigned_trades || !projectData.assigned_trades.includes(jobData.trade_section_id)) {
      return true;
    }
  } else {
    throw new ValidationError('Project id is not valid');
  }
  return false;
}

async function getNextAWRFNumber(jobData: JobDataModel) {
  const awrdCountResult = await executeQuery(`SELECT tracking_number FROM awrf_number_tracking WHERE project_id = $1 AND trade_section_id = $2`, [jobData.project_id, jobData.trade_section_id]);
  if (!awrdCountResult.success) {
    throw new DataBaseError('Error when count assist job');
  }

  let nextAWRFNumber = 1;
  if (!awrdCountResult.data || awrdCountResult.data.length === 0) {
    console.log(`No assist job found for trade section ${jobData.trade_section_id} in project ${jobData.project_id}`);
  } else {
    nextAWRFNumber = awrdCountResult.data[0].tracking_number + 1;
  }
  return nextAWRFNumber;
}

async function validateSupportAndAWRFJob(jobData: JobDataModel) {
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
      : [jobTypeEnum['Main'], jobTypeEnum['AWRF']];

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
}

async function invokeFolderCreation(createProjectFolders: string[]) {
  const bucketName = process.env.DESTINATION_BUCKET;

  if (!bucketName) {
    console.error('DESTINATION_BUCKET environment variable not set');
    throw new Error('Missing required environment variable');
  }

  console.log('Invoking folder creation Lambda');
  console.log('Folder count:', createProjectFolders.length);

  try {
    const results = await Promise.allSettled(
      createProjectFolders.map(folder =>
        s3.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: folder,
          Body: '',
          ContentLength: 0
        }))
      )
    );

    // Log results
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    console.log(`Created ${successful} folders successfully, ${failed} failed`);

    if (failed > 0) {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error(`Failed to create ${createProjectFolders[index]}:`, result.reason.message);
        }
      });
    }

    console.log('Lambda invocation completed successfully');
  } catch (error: any) {
    console.error('Failed to invoke folder creation Lambda:', error.name || 'Unknown error');
    throw new Error('Folder creation failed');
  }
}