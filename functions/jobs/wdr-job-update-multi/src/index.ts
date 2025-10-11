import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery, performTransaction, Operation, DynamicValue } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES, ValidationError, DataBaseError } from 'wdr-error-codes';
import { isValidUUID, isValidCognitoSub, getLoginUserInfo, validateSchema, ValidationSchema } from 'wdr-common-utils';

enum JobStatus {
    Draft = 0,
    Confirmed,
    Cancelled,
    Started,
    Completed
}

enum JobTypeEnum {
    Main = 0,
    Support,
    AWRF
}

const headOfDepartmentCode = 'HOD';

interface JobUpdateInputDataModel {
    id: string,
    tradeSectionId?: string | null,
    subCodeId?: string | null,
}

interface JobUpdateDataModel {
    trade_section_id?: string;
    sub_code?: string;
    updated_date: string;
    updated_by: string;
}

interface ProjectTradeSectionAssigns {
    project_trade_section_id: DynamicValue;
    user_id: string;
    role_id: string;
}

// Define validation schema
const jobUpdateSchema: ValidationSchema = {
    id: { required: true, type: 'uuid', message: 'Job ID must be a valid UUID' },
    tradeSectionId: { required: false, type: 'uuid', message: 'Trade Section ID must be a valid UUID' },
    subCodeId: { required: false, type: 'uuid', message: 'Sub Code ID must be a valid UUID' }
};

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('Receive event', event);

    try {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};

        const projectId = event.queryStringParameters?.['project-id'];
        if (!projectId || !isValidUUID(projectId)) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'Project id is not valid'));
        }

        const requestHeader = event.headers;
        const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

        if (!loginUserId || !isValidCognitoSub(loginUserId)) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'User not logined'));
        }

        const result = await processJobUpdates(body, projectId, loginUserId);
        return new LambdaResponse(200, new ApiResponse(true, result));

    } catch (error: any) {
        console.error('Job update error:', error.name || 'Unknown error');
        if (error.name === 'ValidationError') {
            return LambdaResponse.error(new ApiResponse(false, null, error.message, ERROR_CODES.INVALID_REQUEST.code));
        } else if (error.name === 'DataBaseError') {
            return LambdaResponse.error(new ApiResponse(false, null, error.message, ERROR_CODES.DATABASE_ERROR.code));
        } else {
            return LambdaResponse.error(new ApiResponse(false, null, 'Internal server error', ERROR_CODES.INVALID_REQUEST.code));
        }
    }
};

async function processJobUpdates(body: any, projectId: string, loginUserId: string) {
    const { validJobs, invalidJobCount } = validateJobDatas(body);
    const { jobDataMaps, invalidProjectCount } = await getCurrentJobDatas(validJobs, projectId);
    const { updateJobs, currentUpdateJobDatas } = checkJobUpdateNeedUpdate(jobDataMaps, validJobs);

    const tradeSectionIds = [...new Set(updateJobs.map(job => job.tradeSectionId).filter((id): id is string => !!id))];
    const subCodeIds = [...new Set(updateJobs.map(job => job.subCodeId).filter((id): id is string => !!id))];
    
    const [{ invalidTradeSectionIds }, { invalidSubCodeIds }] = await Promise.all([
        validateTradeSections(tradeSectionIds),
        validateSubcodes(subCodeIds, projectId)
    ]);

    const invalidTradeSectionSet = new Set(invalidTradeSectionIds);
    const invalidSubCodeSet = new Set(invalidSubCodeIds);
    const now = new Date().toUTCString();
    
    const jobResults = await Promise.allSettled(
        updateJobs.map(job => processIndividualJob(job, projectId, currentUpdateJobDatas, loginUserId, now, invalidTradeSectionSet, invalidSubCodeSet))
    );

    const successCount = jobResults.filter(result => result.status === 'fulfilled' && result.value).length;
    const errorCount = jobResults.length - successCount + invalidJobCount + invalidProjectCount;

    return {
        success: validJobs.length - (updateJobs.length - successCount),
        error: errorCount
    };
}

async function processIndividualJob(
    job: JobUpdateInputDataModel, 
    projectId: string, 
    currentUpdateJobDatas: IJobDataResult[], 
    loginUserId: string, 
    updateTime: string,
    invalidTradeSectionSet: Set<string>,
    invalidSubCodeSet: Set<string>
): Promise<boolean> {
    if (job.tradeSectionId && invalidTradeSectionSet.has(job.tradeSectionId)) {
        return false;
    }

    if (job.subCodeId && invalidSubCodeSet.has(job.subCodeId)) {
        return false;
    }

    const operations: Operation[] = [];
    
    if (!await validateJobData(job, projectId, currentUpdateJobDatas, operations, loginUserId, updateTime)) {
        return false;
    }

    if (job.tradeSectionId) {
        await mapAssignTradeSectionToProject(operations, job.tradeSectionId, projectId);
    }

    const transactionResult = await performTransaction(operations);
    return transactionResult.success;
}

function checkJobUpdateNeedUpdate(currentJobDataMaps: IJobDataResult[], jobDatas: JobUpdateInputDataModel[]) {
    const updateJobs: JobUpdateInputDataModel[] = [];
    const currentUpdateJobDatas: IJobDataResult[] = [];

    currentJobDataMaps.forEach(e => {
        const updateJob = jobDatas.find(job => job.id === e.id);
        if (!updateJob) {
            throw new ValidationError(`Job ${e.id} not found in request body`);
        }

        if (updateJob.subCodeId !== e.sub_code || updateJob.tradeSectionId !== e.trade_section_id) {
            updateJobs.push(updateJob);
            currentUpdateJobDatas.push(e);
        }
    });

    return { updateJobs, currentUpdateJobDatas };
}

function validateJobDatas(body: any) {
    // Validate input is array
    if (!Array.isArray(body)) {
        throw new ValidationError('Request body must be an array');
    }

    const jobDatas: JobUpdateInputDataModel[] = body;
    const invalidJobs: JobUpdateInputDataModel[] = [];

    jobDatas.forEach(job => {
        const validation = validateSchema(job, jobUpdateSchema);
        if (!validation.isValid) {
            invalidJobs.push(job);
        }
    });

    const invalidJobsSet = new Set(invalidJobs);
    return { validJobs: jobDatas.filter(e => !invalidJobsSet.has(e)), invalidJobCount: invalidJobs.length };
}

interface IJobDataResult {
    id: string;
    title: string;
    trade_section_id: null | string;
    sub_code: null | string;
    job_type: number;
}

async function getCurrentJobDatas(jobDatas: JobUpdateInputDataModel[], projectId: string) {
    const jobIds = [...new Set(jobDatas.map(job => job.id))];
    let invalidProjectCount = 0;
    const jobDataMaps: IJobDataResult[] = [];

    // Only job with Draft status allow bulk update
    const getJobDataResult = await executeQuery(`SELECT id, title, trade_section_id, sub_code, job_type FROM jobs WHERE id = ANY($1) AND project_id = $2 AND status = $3`,
        [jobIds, projectId, JobStatus.Draft]);

    if (!getJobDataResult.success) {
        throw new DataBaseError('Failed to get job data');
    }

    if (getJobDataResult.rowCount === 0) {
        invalidProjectCount = jobDatas.length;
    } else {
        const validJobIds: string[] = getJobDataResult.data.map((row: any) => row.id);
        jobDataMaps.push(...getJobDataResult.data as IJobDataResult[]);
        const validJobIdsSet = new Set(validJobIds);
        const invalidJobs = jobIds.filter(id => !validJobIdsSet.has(id));
        invalidProjectCount = invalidJobs.length;
    }

    return { jobDataMaps, invalidProjectCount };
}

async function validateJobData(jobData: JobUpdateInputDataModel, projectId: string, jobDataMaps: IJobDataResult[], operations: Operation[], loginUserId: string, updateTime: string) {
    const currentJobData = jobDataMaps.find(e => e.id === jobData.id);

    if (!currentJobData) {
        throw new DataBaseError(`Job with ID ${jobData.id} not found in database`);
    }

    const data: JobUpdateDataModel = {
        updated_by: loginUserId,
        updated_date: updateTime,
    }

    if (jobData.tradeSectionId && currentJobData.trade_section_id !== jobData.tradeSectionId) {
        // Check title in case job is main job
        if (currentJobData.job_type === JobTypeEnum.Main) {
            const title = currentJobData.title;

            const checkJobTitleResult = await executeQuery(`SELECT EXISTS (
            SELECT 1 FROM jobs WHERE title = $1 AND id != $2 AND trade_section_id = $3 AND project_id = $4)`,
                [title, jobData.id, jobData.tradeSectionId, projectId]
            )

            if (!checkJobTitleResult.success) {
                throw new DataBaseError('Failed to check job title');
            }

            if (checkJobTitleResult.data[0].exists) {
                return false;
            }
        }
        data.trade_section_id = jobData.tradeSectionId;
    }

    if (jobData.subCodeId) {
        data.sub_code = jobData.subCodeId;
    }

    operations.push({
        type: 'update',
        table: 'jobs',
        data: data,
        condition: { id: jobData.id },
        returningClause: '*'
    });

    return true;
}

async function validateTradeSections(tradeSectionIds: string[]) {
    if (tradeSectionIds.length === 0) {
        return { invalidTradeSectionIds: [] };
    }

    const validateTradeSectionResult = await executeQuery(`SELECT id FROM trade_sections WHERE id = ANY($1)`,
        [tradeSectionIds]);

    if (!validateTradeSectionResult.success) {
        throw new DataBaseError('Failed to validate trade sections');
    }

    const validTradeSectionIds = validateTradeSectionResult.data.map((row: any) => row.id);
    const validSet = new Set(validTradeSectionIds);
    const invalidTradeSectionIds = tradeSectionIds.filter(id => !validSet.has(id));

    return { invalidTradeSectionIds };
}

async function validateSubcodes(subCodeIds: string[], projectId: string) {
    if (subCodeIds.length === 0) {
        return { invalidSubCodeIds: [] };
    }

    const validateSubCodesResult = await executeQuery(`SELECT id FROM sub_codes WHERE id = ANY($2) AND project_id = $1`,
        [projectId, subCodeIds]);

    if (!validateSubCodesResult.success) {
        throw new DataBaseError('Failed to validate sub codes');
    }

    const validSubCodeIds = validateSubCodesResult.data.map((row: any) => row.id);
    const validSet = new Set(validSubCodeIds);
    const invalidSubCodeIds = subCodeIds.filter(id => !validSet.has(id));

    return { invalidSubCodeIds };
}

async function mapAssignTradeSectionToProject(operations: Operation[], tradeSectionId: string, projectId: string) {
    const assignedTradeInProjectResult = await executeQuery(
        `SELECT EXISTS (SELECT 1 FROM project_trade_sections WHERE trade_section_id = $1 AND project_id = $2)`,
        [tradeSectionId, projectId]
    );
    if (!assignedTradeInProjectResult.success) {
        throw new DataBaseError('Failed to check existed trade section in project');
    }

    if (!assignedTradeInProjectResult.data[0]?.exists) {
        await assignHODBatch(operations, projectId, tradeSectionId);
    }
}

async function assignHODBatch(operations: Operation[], project_id: string, tradeSectionId: string) {
    // Add project_trade_sections inserts for all trade sections
    operations.push({
        type: 'insert',
        table: 'project_trade_sections',
        data: {
            project_id: project_id,
            trade_section_id: tradeSectionId,
        },
        returningClause: '*'
    });

    try {
        // Batch query for all HODs
        const selectHODQuery = `SELECT uts.user_id, uts.role_id, uts.trade_section_id FROM user_trade_sections uts JOIN roles r ON r.id = uts.role_id 
                    WHERE uts.trade_section_id = $1 AND r.code = $2`;
        const hodResult = await executeQuery(selectHODQuery, [tradeSectionId, headOfDepartmentCode]);

        if (!hodResult.success) {
            throw new ValidationError('Error retrieving HOD for the trade sections');
        }

        if (hodResult.data.length > 0) {
            hodResult.data.forEach((hod: { user_id: string; role_id: string; trade_section_id: string }) => {
                const projectTradeSectionAssigns: ProjectTradeSectionAssigns = {
                    project_trade_section_id: {
                        type: 'dynamic_result',
                        fromIndex: operations.length - 1,
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
        }
    } catch (error: any) {
        console.error('HOD assignment failed', error);
        throw new ValidationError('Error retrieving HOD for the trade sections');
    }
}