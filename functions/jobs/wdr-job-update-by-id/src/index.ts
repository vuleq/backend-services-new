import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery, performTransaction, Operation, DynamicValue } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES, ValidationError, DataBaseError } from 'wdr-error-codes';
import { isValidUUID, isValidCognitoSub, getLoginUserInfo, isValidDate } from 'wdr-common-utils';

enum JobStatus {
    Draft = 0,
    Confirmed,
    Cancelled,
    Started,
    Completed
}

enum ProjectRole {
    SU = 0,
    SRM
}

enum JobTypeEnum {
    Main = 0,
    Support,
    AWRF
}

enum TradeMemberRoleCode {
    HOD = 'HOD',
    FOR = 'FOR',
    TS = 'TS'
}

interface JobUpdateDataModel {
    trade_section_id: string;
    title: string;
    sub_code: string;
    owner_job_number: string;
    description: string;
    plan_start_date: string;
    plan_complete_date: string;
    actual_start_date: string;
    actual_complete_date: string;
    remark: string;
    updated_date: string;
    updated_by: string;
    awrf_number?: string;
}

interface JobData {
    status: number;
    sub_code: string;
    project_id: string;
    trade_section_id: string;
    job_type: number;
}

interface ProjectTradeSectionAssigns {
    project_trade_section_id: DynamicValue;
    user_id: string;
    role_id: string;
}

const headOfDepartmentCode = 'HOD';

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('Receive event', event);

    try {
        const jobId = event.pathParameters?.id;

        if (!jobId || !isValidUUID(jobId)) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'Job id is required'));
        }

        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
        const requestHeader = event.headers;
        const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

        if (!loginUserId || !isValidCognitoSub(loginUserId)) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'User not logined'));
        }

        const jobData: JobUpdateDataModel = {
            trade_section_id: body.tradeSectionId ?? null,
            sub_code: body.subCode ?? null,
            owner_job_number: body.ownerJobNumber ?? null,
            title: body.title ?? null,
            description: body.description ?? null,
            plan_start_date: body.planStartDate ?? null,
            plan_complete_date: body.planCompleteDate ?? null,
            actual_start_date: body.actualStartDate ?? null,
            actual_complete_date: body.actualCompleteDate ?? null,
            remark: body.remark ?? null,
            updated_date: new Date().toISOString(),
            updated_by: loginUserId
        };

        console.log('Job Data received for processing');

        const currentJob = await getCurrentJob(jobId);

        const hasAccess = await isUserAllowToEditJob(loginUserId, currentJob);
        if (!hasAccess) {
            return new LambdaResponse(403, new ApiResponse(false, null, 'User do not has permission to edit job detail'));
        }

        await validateInput(jobData);

        const tradeSectionName = await validateRelationship(jobData, currentJob, jobId);
        const nextAWRFNumber = await validateAWRF(jobData, currentJob, tradeSectionName);
        const isAddNewTradeToProject = await checkTradeAssigned(jobData.trade_section_id, currentJob.trade_section_id, currentJob.project_id);

        const operations: Operation[] = [];
        operations.push({
            type: 'update',
            table: 'jobs',
            data: jobData,
            condition: { id: jobId },
            returningClause: '*'
        });

        if (isAddNewTradeToProject) {
            await assignHOD(operations, currentJob.project_id, jobData.trade_section_id);
        }

        if (nextAWRFNumber) {
            modifyAWRFTracking(nextAWRFNumber, operations, currentJob, jobData);
        }

        const result = await performTransaction(operations);
        console.log('Transaction completed:', result.success ? 'success' : 'failed');

        if (result.success) {
            const resultData = result.results?.[0][0];
            return new LambdaResponse(200, new ApiResponse(true, resultData, 'Job updated successfully'));
        }

        return new LambdaResponse(400, new ApiResponse(false, null, 'Job updated failed!', result));

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

function modifyAWRFTracking(nextAWRFNumber: number, operations: Operation[], currentJob: JobData, jobData: JobUpdateDataModel) {
    if (nextAWRFNumber === 1) {
        operations.push({
            type: 'insert',
            table: 'awrf_number_tracking',
            data: {
                project_id: currentJob.project_id,
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
                    project_id: currentJob.project_id,
                    trade_section_id: jobData.trade_section_id
                }
            }
        );
    }
}

async function validateAWRF(jobData: JobUpdateDataModel, currentJob: JobData, tradeSectionName: string | null) {
    if (jobData.trade_section_id !== currentJob.trade_section_id && currentJob.job_type === JobTypeEnum.AWRF && tradeSectionName) {
        const nextAWRFNumber = await getNextAWRFNumber(currentJob.project_id, jobData.trade_section_id);
        jobData.awrf_number = `AWRF-${tradeSectionName[0]}-${nextAWRFNumber}`; // Change AWRF number if trade section changes
        return nextAWRFNumber;
    }
    return null;
}

async function getNextAWRFNumber(project_id: string, trade_section_id: string) {
    const awrdCountResult = await executeQuery(`SELECT tracking_number FROM awrf_number_tracking WHERE project_id = $1 AND trade_section_id = $2`, [project_id, trade_section_id]);
    if (!awrdCountResult.success) {
        throw new DataBaseError('Error when count assist job');
    }

    let nextAWRFNumber = 1;
    if (!awrdCountResult.data || awrdCountResult.data.length === 0) {
        console.log(`No assist job found for trade section ${trade_section_id} in project ${project_id}`);
    } else {
        nextAWRFNumber = awrdCountResult.data[0].tracking_number + 1;
    }
    return nextAWRFNumber;
}


async function checkTradeAssigned(newTradeId: string, currentTradeId: string, project_id: string) {
    if (newTradeId !== currentTradeId) {
        const tradeAssignSql = `SELECT EXISTS (SELECT 1 FROM project_trade_sections WHERE trade_section_id = $1 AND project_id = $2)`;
        const tradeParams = [newTradeId, project_id];
        const tradeAssignResult = await executeQuery(tradeAssignSql, tradeParams);

        if (!tradeAssignResult.success) {
            throw new DataBaseError('Error when get assign trade section');
        }

        return !tradeAssignResult.data[0].exists;
    }
    return false;
}

async function isUserAllowToEditJob(userId: string, jobData: JobData) {
    // SRM and Super User can update
    const checkProjectRoleResult = await executeQuery(
        `SELECT EXISTS (SELECT 1 FROM project_assignments pa WHERE pa.user_id = $1 AND pa.project_id = $2 AND pa.role = ANY($3))`,
        [userId, jobData.project_id, [ProjectRole.SU, ProjectRole.SRM]]
    );

    if (!checkProjectRoleResult.success) {
        console.error('Failed to check project role');
        return false;
    }

    if (checkProjectRoleResult.data[0].exists) {
        return true;
    }

    // HOD of trade can update
    if (jobData.trade_section_id) {
        const checkTradeRoleResult = await executeQuery(
            `SELECT EXISTS (SELECT 1 FROM project_trade_sections pts 
        LEFT JOIN project_trade_section_assigns ptsa ON pts.id = ptsa.project_trade_section_id 
        LEFT JOIN roles r ON ptsa.role_id = r.id
        WHERE pts.trade_section_id = $1 AND ptsa.user_id = $2 AND r.code = ANY($3))`,
            [jobData.trade_section_id, userId, [TradeMemberRoleCode.HOD]]
        );

        if (!checkTradeRoleResult.success) {
            console.error('Failed to check trade role');
            return false;
        }

        return checkTradeRoleResult.data[0].exists;
    }

    return false;
}

async function validateInput(jobData: JobUpdateDataModel) {
    if (!jobData.title || jobData.title.trim().length === 0) {
        throw new ValidationError('Title is required');
    }
    jobData.title = jobData.title.trim();

    if (!jobData.sub_code || !isValidUUID(jobData.sub_code)) {
        throw new ValidationError('Sub code is not valid');
    }

    if (!jobData.trade_section_id || !isValidUUID(jobData.trade_section_id)) {
        throw new ValidationError('Trade section id is not valid');
    }

    if (!jobData.owner_job_number || jobData.owner_job_number.trim().length === 0) {
        throw new ValidationError('Owner job number is required');
    }
    jobData.owner_job_number = jobData.owner_job_number.trim();

    // Validate date
    if (jobData.plan_start_date && !isValidDate(jobData.plan_start_date)) {
        throw new ValidationError('Invalid plan start date');
    }

    if (jobData.plan_complete_date && !isValidDate(jobData.plan_complete_date)) {
        throw new ValidationError('Invalid plan complete date');
    }

    if (jobData.actual_start_date && !isValidDate(jobData.actual_start_date)) {
        throw new ValidationError('Invalid actual start date');
    }

    if (jobData.actual_complete_date && !isValidDate(jobData.actual_complete_date)) {
        throw new ValidationError('Invalid actual complete date');
    }

    // Validate date ranges
    if (jobData.plan_start_date && jobData.plan_complete_date) {
        if (new Date(jobData.plan_start_date) > new Date(jobData.plan_complete_date)) {
            throw new ValidationError('Plan start date cannot be after plan complete date');
        }
    }

    if (jobData.actual_start_date && jobData.actual_complete_date) {
        if (new Date(jobData.actual_start_date) > new Date(jobData.actual_complete_date)) {
            throw new ValidationError('Actual start date cannot be after actual complete date');
        }
    }
}

async function getCurrentJob(jobId: string): Promise<JobData> {
    try {
        const currentJobSql = `SELECT status, sub_code, project_id, trade_section_id, job_type FROM jobs WHERE id = $1`;
        const currentJobParams = [jobId];
        const currentJobResult = await executeQuery(currentJobSql, currentJobParams);

        if (currentJobResult.error) {
            throw new DataBaseError('Error when fetching job data');
        }

        console.log('Current job query completed:', currentJobResult.success ? 'success' : 'failed');
        if (currentJobResult.success && currentJobResult.rowCount === 0) {
            throw new ValidationError('Invalid Job id');
        }

        return currentJobResult.data[0];
    } catch (error) {
        console.error('Database query failed for job retrieval');
        throw new ValidationError('Error when fetching job data');
    }
}

async function validateRelationship(jobData: JobUpdateDataModel, currentJob: JobData, jobId: string) {
    if (currentJob.status === JobStatus['Cancelled'] || currentJob.status === JobStatus['Completed']) {
        throw new ValidationError('Cannot update a job with status Cancelled or Completed');
    }

    // Only main job need validate title
    if (currentJob.job_type === JobTypeEnum['Main']) {
        const jobTitleResult = await executeQuery(`SELECT EXISTS (SELECT 1 FROM jobs WHERE title = $1 AND id != $2 AND trade_section_id = $3 AND project_id = $4)`,
            [jobData.title, jobId, jobData.trade_section_id, currentJob.project_id]);
        if (!jobTitleResult.success) {
            throw new DataBaseError('Error when get job title');
        }

        if (jobTitleResult.data[0].exists) {
            throw new ValidationError('Job title already exists');
        }
    }

    if (currentJob.sub_code !== jobData.sub_code) {
        const subCodeSql = `SELECT EXISTS (SELECT 1 FROM sub_codes WHERE id = $1 AND project_id = $2)`;
        const subCodeParams = [jobData.sub_code, currentJob.project_id];
        const subCodeResult = await executeQuery(subCodeSql, subCodeParams);
        console.log('Sub code validation completed:', subCodeResult.success ? 'success' : 'failed');

        if (!subCodeResult.success) {
            throw new DataBaseError('Error when get sub code');
        }

        if (!subCodeResult.data[0].exists) {
            throw new ValidationError('Sub code does not exists in project');
        }
    }

    if (currentJob.trade_section_id !== jobData.trade_section_id) {
        const tradeResult = await executeQuery(`SELECT name FROM trade_sections WHERE id = $1`, [jobData.trade_section_id]);
        if (!tradeResult.success) {
            throw new DataBaseError('Error when get trade section');
        }

        if (tradeResult.rowCount === 0) {
            throw new ValidationError('Trade section does not exists in project');
        }

        return tradeResult.data[0].name;
    }

    return null;
}
async function assignHOD(operations: Operation[], project_id: string, trade_section_id: string) {
    operations.push({
        type: 'insert',
        table: 'project_trade_sections',
        data: {
            project_id: project_id,
            trade_section_id: trade_section_id,
        },
        returningClause: '*'
    });

    try {
        const selectHODQuery = `SELECT uts.user_id, uts.role_id FROM user_trade_sections uts JOIN roles r ON r.id = uts.role_id 
                    WHERE uts.trade_section_id = $1 AND r.code = $2`;
        const selectHODParams = [trade_section_id, headOfDepartmentCode];
        const hodResult = await executeQuery(selectHODQuery, selectHODParams);
        console.log('HOD query completed:', hodResult.success ? 'success' : 'failed');

        if (hodResult.success && 'data' in hodResult && Array.isArray(hodResult.data)) {
            if (hodResult.data.length > 0) {
                hodResult.data.forEach((hod: { user_id: string; role_id: string }) => {
                    const projectTradeSectionAssigns: ProjectTradeSectionAssigns = {
                        project_trade_section_id: {
                            type: 'dynamic_result',
                            fromIndex: 1, // index count from 0 with update job = 0, insert project_trade_sections = 1
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
    } catch (error) {
        console.error('HOD assignment failed', error);
        throw new ValidationError('Error retrieving HOD for the trade section');
    }
}

