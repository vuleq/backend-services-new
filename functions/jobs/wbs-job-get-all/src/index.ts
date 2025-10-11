import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { isValidUUID } from 'wdr-common-utils';
import { buildError } from 'wdr-error-codes';

const jobTypeEnum: Record<string, number> = {
  'Main': 0,
  'Support': 1,
  'AWRF': 2
};

const jobStatus: Record<string, number> = {
  Draft: 0,
  Confirmed: 1,
  Cancelled: 2,
  Started: 3,
  Completed: 4
};

const WDRStatus: Record<string, number> = {
  'Not started': 0,
  Draft: 1,
  'Pre review': 2,
  'HOD review': 3,
  'SRM review': 4,
  Completed: 5
};

const statusToString: Record<number, string> = Object.fromEntries(
  Object.entries(jobStatus).map(([k, v]) => [v, k])
);

const wdrStatusToString: Record<number, string> = Object.fromEntries(
  Object.entries(WDRStatus).map(([k, v]) => [v, k])
);

const jobTypeToString: Record<number, string> = Object.fromEntries(
  Object.entries(jobTypeEnum).map(([k, v]) => [v, k])
);

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Received event:', JSON.stringify(event, null, 2));
    const projectId = event.queryStringParameters?.['project-id'];
    const jobTypes = event.multiValueQueryStringParameters?.['job-types'];
    const status = event.multiValueQueryStringParameters?.['status'];
    const mainJobId = event.queryStringParameters?.['main-job-id'];
    const wdrStatus = event.multiValueQueryStringParameters?.['wdr-status'];

    let selectSql = 'SELECT j.*, sc.sub_no as sub_no, ts.name as trade_section FROM jobs j JOIN sub_codes sc ON sc.id = j.sub_code JOIN trade_sections ts ON ts.id = j.trade_section_id';
    let selectParams = [];
    const conditions = [];
    let paramIndex = 1;

    if (projectId && isValidUUID(projectId)) {
      conditions.push(`j.project_id = $${paramIndex++}`);
      selectParams.push(projectId);
    }

    if (jobTypes) {
      const jobTypesNumeric = jobTypes.map(type => jobTypeEnum[type]).filter(val => val !== undefined);
      if (jobTypesNumeric.length === 0) {
        const error = buildError('INVALID_REQUEST', 'Invalid job types');
        return new LambdaResponse(400, error);
      }
      conditions.push(`j.job_type = ANY($${paramIndex++})`);
      selectParams.push(jobTypesNumeric);
    }

    if (mainJobId) {
      if (!isValidUUID(mainJobId)) {
        const error = buildError('INVALID_REQUEST', 'Invalid main job ID');
        return new LambdaResponse(400, error);
      }
      conditions.push(`j.main_job_id = $${paramIndex++}`);
      selectParams.push(mainJobId);
    }

    if (status) {
      const statusValues = status.map(s => jobStatus[s]).filter(val => val !== undefined);
      if (statusValues.length === 0) {
        const error = buildError('INVALID_REQUEST', 'Invalid status values');
        return new LambdaResponse(400, error);
      }
      conditions.push(`j.status = ANY($${paramIndex++})`);
      selectParams.push(statusValues);
    }

    if (wdrStatus) {
      const wdrStatusValues = wdrStatus.map(s => WDRStatus[s]).filter(val => val !== undefined);
      if (wdrStatusValues.length === 0) {
        const error = buildError('INVALID_REQUEST', 'Invalid WDR status values');
        return new LambdaResponse(400, error);
      }
      conditions.push(`j.wdr_status = ANY($${paramIndex++})`);
      selectParams.push(wdrStatusValues);
    }

    if (conditions.length > 0) {
      selectSql += ' WHERE ' + conditions.join(' AND ');
    }

    const result = await executeQuery(selectSql, selectParams);

    if (result.success) {
      const mappedData = result.data.map((job: any) => ({
        ...job,
        status: statusToString[job.status] || job.status,
        wdr_status: wdrStatusToString[job.wdr_status] || job.wdr_status,
        job_type: jobTypeToString[job.job_type] || job.job_type
      }));
      return new LambdaResponse(200, new ApiResponse(true, mappedData));
    }

    const error = buildError('DATABASE_ERROR', 'Failed to get jobs');
    return new LambdaResponse(400, error);
  } catch (error: any) {
    console.error('Error:', error);
    const errorResponse = buildError('LAMBDA_SERVICE_EXCEPTION', error.message);
    return new LambdaResponse(500, errorResponse);
  }
};