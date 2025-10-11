import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { executeQuery, performTransaction, Operation } from 'wdr-connect-db';
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

const s3Folder = {
  compress: 'compress',
  results: 'results'
};

const defaultUserId = "00000000-0000-0000-0000-000000000000";
const defaultUserName = 'PaxOcean Admin';

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

interface JobToDelete {
  id: string;
  title: string;
  status: number;
  project_id: string;
}

interface DeleteJobRequest {
  jobIds: string[];
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Raw event.body:', event.body);
  console.log('Event body type:', typeof event.body);

  try {
    const body = typeof event?.body === 'string' ? JSON.parse(event.body) : event?.body || {};

    console.log('Parsed body:', JSON.stringify(body, null, 2));
    console.log('body.jobIds:', body.jobIds);
    console.log('body.jobIds type:', typeof body.jobIds);
    console.log('body.jobIds isArray:', Array.isArray(body.jobIds));

    const requestHeader = event?.headers || {};
    const { userId, userName } = getLoginUserInfo(requestHeader);

    const deleteRequest: DeleteJobRequest = {
      jobIds: body.jobIds
    };

    console.log('deleteRequest.jobIds:', deleteRequest.jobIds);

    // Validate delete request
    await validateDeleteRequest(deleteRequest);

    // Get jobs to delete and validate they can be deleted
    const jobsToDelete = await getJobsToDelete(deleteRequest.jobIds);

    // Prepare transaction operations
    const operations: Operation[] = [];

    // Delete jobs
    deleteRequest.jobIds.forEach(jobId => {
      operations.push({
        type: 'delete',
        table: 'jobs',
        condition: { id: jobId }
      });
    });

    // Execute transaction
    const result = await performTransaction(operations);
    console.log('Delete transaction completed:', result.success ? 'success' : 'failed');

    if (result.success) {
      // Delete S3 folders for deleted jobs
      const deleteProjectFolders: string[] = [];
      jobsToDelete.forEach(job => {
        deleteProjectFolders.push(
          `${s3Folder.compress}/${job.project_id}/${job.id}/`,
          `${s3Folder.results}/${job.project_id}/${job.id}/`
        );
      });

      // Invoke folder deletion (fire and forget - don't fail if this fails)
      try {
        await invokeFolderDeletion(deleteProjectFolders);
      } catch (error) {
        console.error('Failed to delete S3 folders, but job deletion was successful:', error);
      }

      return LambdaResponse.success(new ApiResponse(true, {
        deletedJobIds: deleteRequest.jobIds,
        deletedJobTitles: jobsToDelete.map(job => job.title)
      }, `Successfully deleted ${deleteRequest.jobIds.length} job(s)`));
    }

    return LambdaResponse.error(new ApiResponse(false, null, 'Job deletion failed!', result.success !== undefined ? result.error : result));

  } catch (error: any) {
    console.error('Job deletion error:', error.name || 'Unknown error');
    if (error.name === 'ValidationError') {
      return LambdaResponse.error(new ApiResponse(false, null, error.message, ERROR_CODES.INVALID_REQUEST.code));
    } else {
      return LambdaResponse.error(new ApiResponse(false, null, 'Internal server error', ERROR_CODES.INVALID_REQUEST.code));
    }
  }
};

async function validateDeleteRequest(deleteRequest: DeleteJobRequest) {
  // Validate job IDs array
  if (!deleteRequest.jobIds || !Array.isArray(deleteRequest.jobIds) || deleteRequest.jobIds.length === 0) {
    throw new ValidationError('At least 1 job ID is required for deletion');
  }

  // Validate each job ID is a valid UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const jobId of deleteRequest.jobIds) {
    if (!uuidRegex.test(jobId)) {
      throw new ValidationError(`Invalid job ID format: ${jobId}`);
    }
  }
}

async function getJobsToDelete(jobIds: string[]): Promise<JobToDelete[]> {
  const placeholders = jobIds.map((_, index) => `$${index + 1}`).join(',');
  const query = `
    SELECT id, title, status, project_id
    FROM jobs 
    WHERE id IN (${placeholders})
  `;

  const result = await executeQuery(query, jobIds);
  console.log('Jobs to delete query completed:', result.success ? 'success' : 'failed');

  if (!result.success) {
    throw new ValidationError('Failed to retrieve jobs to delete');
  }

  if (result.data.length !== jobIds.length) {
    const foundIds = result.data.map((job: JobToDelete) => job.id);
    const missingIds = jobIds.filter(id => !foundIds.includes(id));
    throw new ValidationError(`Some jobs were not found: ${missingIds.join(', ')}`);
  }

  // Validate jobs can be deleted (only Draft status jobs can be deleted)
  const nonDeletableJobs = result.data.filter((job: JobToDelete) => job.status !== jobStatus.Draft);
  if (nonDeletableJobs.length > 0) {
    const nonDeletableTitles = nonDeletableJobs.map((job: JobToDelete) => job.title);
    throw new ValidationError(`Only jobs in Draft status can be deleted. Non-deletable jobs: ${nonDeletableTitles.join(', ')}`);
  }

  // Check if any of these jobs are main jobs with supporting/assist jobs
  const mainJobIds = jobIds.join("','");
  const dependentJobsQuery = `
    SELECT main_job_id, COUNT(*) as dependent_count
    FROM jobs 
    WHERE main_job_id IN ('${mainJobIds}')
    GROUP BY main_job_id
  `;

  const dependentResult = await executeQuery(dependentJobsQuery, []);
  console.log('Dependent jobs query completed:', dependentResult.success ? 'success' : 'failed');

  if (dependentResult.success && dependentResult.data.length > 0) {
    const jobsWithDependents = dependentResult.data.map((dep: any) => dep.main_job_id);
    throw new ValidationError(`Cannot delete jobs that have supporting/assist jobs. Jobs with dependents: ${jobsWithDependents.join(', ')}`);
  }

  return result.data;
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