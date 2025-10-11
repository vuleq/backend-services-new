import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { executeQuery, updateRecord, performTransaction, Operation } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { buildError } from 'wdr-error-codes';
import { isValidUUID, isValidCognitoSub, getLoginUserInfo } from 'wdr-common-utils';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// Lazy initialization to avoid cold start overhead
let lambdaClient: LambdaClient | null = null;

function getLambdaClient(): LambdaClient {
    if (!lambdaClient) {
        lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });
    }
    return lambdaClient;
}

enum JobStatus {
    Draft = 0,
    Confirmed,
    Cancelled,
    Started,
    Completed
}

enum WDRStatus {
    'Not started' = 0,
    Draft,
    'Pre review',
    'HOD review',
    'SRM review',
    Completed
}

const roleNameCode = {
    'Head of Department': 'HOD',
    'Trade Supervisor': 'TS',
    'Foreman': 'FOR'
};

const projectRoleEnum = {
    'Super User': 0,
    'SRM': 1,
};

const reportType = Object.freeze({
    TEMPLATE: 0,
    HEADER: 1,
    FOOTER: 2,
    REPORT: 3,
    COVER: 4
});

class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValidationError';
        Error.captureStackTrace(this, ValidationError);
    }
}

function getNextStatus(currentStatus: number) {
    if (currentStatus === null || currentStatus === undefined) {
        throw new ValidationError('Current status is required');
    }
    switch (currentStatus) {
        case JobStatus.Draft:
            return [JobStatus.Confirmed, JobStatus.Cancelled];
        case JobStatus.Confirmed:
            return [JobStatus.Started, JobStatus.Cancelled];
        case JobStatus.Started:
            return [JobStatus.Completed, JobStatus.Cancelled];
        case JobStatus.Completed:
        case JobStatus.Cancelled:
            return [];
        default:
            throw new ValidationError(`Invalid current status: ${currentStatus}`);
    }
}

interface CreateReportData {
    awrf_no: string;
    job_title: string;
    project_id: string;
    sub_code: string;
    template_id: string;
    trade_section: string;
    type: number;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('Processing job status change request');

    try {
        const jobId = event.pathParameters?.id;

        if (!jobId || !isValidUUID(jobId)) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'Job id is required'));
        }

        let body;
        try {
            body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
        } catch (error) {
            return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Invalid JSON in request body'));
        }
        const requestHeader = event.headers;
        const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

        let newStatus: any = null;
        if ('status' in body) {
            if (body.status in JobStatus) {
                newStatus = JobStatus[body.status as keyof typeof JobStatus];
            } else {
                return new LambdaResponse(400, buildError('INVALID_REQUEST', "New status not valid"));
            }
        }

        const progress = body.progress;

        console.log('Job update status received for processing');

        if (!loginUserId || !isValidCognitoSub(loginUserId)) {
            return new LambdaResponse(400, buildError('INVALID_REQUEST', "No user logined"));
        }

        const currentJobResult = await executeQuery(`SELECT j.status, j.trade_section_id, j.project_id, j.awrf_number, j.title, j.wdr_status, sc.sub_no FROM jobs j 
            LEFT JOIN sub_codes sc ON sc.id = j.sub_code
            WHERE j.id = $1`, [jobId]);
        if (!currentJobResult.success || currentJobResult.data.length === 0) {
            return LambdaResponse.error(buildError('RESOURCE_NOT_FOUND', 'Job not found'));
        }
        const currentStatus = currentJobResult.data[0].status;
        const tradeSectionId = currentJobResult.data[0].trade_section_id;
        const projectId = currentJobResult.data[0].project_id;
        const title = currentJobResult.data[0].title;
        const awrfNo = currentJobResult.data[0].awrf_number ?? '';
        const subNo = currentJobResult.data[0].sub_no ?? '';
        const wdrStatus = currentJobResult.data[0].wdr_status && currentJobResult.data[0].wdr_status in WDRStatus ? WDRStatus[currentJobResult.data[0].wdr_status as keyof typeof WDRStatus] : null;

        let finalStatus = currentStatus;

        if (newStatus !== null) {
            const nextValidStatus: number[] = getNextStatus(currentStatus);
            if (newStatus !== currentStatus && !nextValidStatus.includes(newStatus)) {
                return new LambdaResponse(400, buildError('INVALID_REQUEST', 'New status is not valid'));
            }
            finalStatus = newStatus;
        }

        const isTradeRoleCanChangeStatus = newStatus === JobStatus['Started'] || newStatus === JobStatus['Completed'];

        const validProjectRoles = [projectRoleEnum.SRM, projectRoleEnum['Super User']];
        const rolesInProjectResult = await executeQuery(`SELECT EXISTS (SELECT 1 FROM project_assignments WHERE project_id = $1 AND user_id = $2 AND role = ANY($3)) as exist`, [projectId, loginUserId, validProjectRoles]);

        if (!rolesInProjectResult.success || rolesInProjectResult.data.length === 0 || !rolesInProjectResult.data[0].exist) {
            if (isTradeRoleCanChangeStatus && tradeSectionId) {
                const validTradeRoles = [roleNameCode['Trade Supervisor'], roleNameCode['Foreman'], roleNameCode['Head of Department']];
                const rolesInTradeResult = await executeQuery(`SELECT EXISTS (SELECT 1 FROM project_trade_section_assigns ptsa
                    LEFT JOIN project_trade_sections pts ON ptsa.project_trade_section_id = pts.id
                    LEFT JOIN roles r ON r.id = ptsa.role_id WHERE pts.project_id = $1 AND pts.trade_section_id = $2 AND ptsa.user_id = $3 AND r.code = ANY($4)) as exist`, [projectId, tradeSectionId, loginUserId, validTradeRoles]);
                if (!rolesInTradeResult.success || rolesInTradeResult.data.length === 0 || !rolesInTradeResult.data[0].exist) {
                    return new LambdaResponse(403, buildError('ACCESS_DENIED', 'User does not have permission to change job status'));
                }
            } else {
                return new LambdaResponse(403, buildError('ACCESS_DENIED', 'User does not have permission to change job status'));
            }
        }

        if (currentStatus === JobStatus.Started && body.hasOwnProperty('progress')) {
            const progressValue = Number(progress);

            if (isNaN(progressValue) || progressValue < 0 || progressValue > 100) {
                return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Progress must be a number between 0 and 100'));
            }

            if (progressValue === 100) {
                finalStatus = JobStatus.Completed;
            }
        }

        const updateData: { status: number; wdr_status?: number, progress?: number } = {
            status: finalStatus
        }

        if (body.hasOwnProperty('progress') && finalStatus === JobStatus.Started) {
            updateData.progress = Number(progress);
        }

        let reportId: string | null = null;

        if (finalStatus === JobStatus.Completed) {
            if (wdrStatus !== WDRStatus['Not started']) {
                const getReportResult = await executeQuery(`SELECT id FROM report WHERE type = $1 AND trade_section = $2 AND project_id = $3 AND job_title = $4 ORDER BY version desc LIMIT 1`,
                    [reportType.REPORT, tradeSectionId, projectId, title]);

                if (!getReportResult.success) {
                    return new LambdaResponse(400, buildError('DATABASE_ERROR', 'Failed to get report detail'));
                }

                const result = getReportResult.data?.[0];

                if (result) {
                    reportId = result.id;
                } else {
                    console.log(`Not found report - create new report`);
                }
            }

            if (reportId === null) {
                const getTemplateResult = await executeQuery(`SELECT id FROM report WHERE type = $1 AND trade_section = $2 AND is_default = true LIMIT 1`,
                    [reportType.TEMPLATE, tradeSectionId]);

                if (!getTemplateResult.success) {
                    return new LambdaResponse(400, buildError('DATABASE_ERROR', 'Failed to get report template'));
                }

                const template = getTemplateResult.data?.[0];

                if (!template) {
                    return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Trade section does not has default template'));
                }

                const createNewReportData = {
                    awrf_no: awrfNo,
                    job_title: title,
                    project_id: projectId,
                    sub_code: subNo,
                    template_id: template.id,
                    trade_section: tradeSectionId,
                    type: reportType.REPORT,
                    job_id: jobId
                }
                console.log("createNewReportData", createNewReportData)

                reportId = await invokeCreateReport(createNewReportData, requestHeader);
                updateData.wdr_status = WDRStatus.Draft;
            }

            updateData.progress = 100;
        }

        const operations: Operation[] = [
            {
                type: 'update',
                table: 'jobs',
                data: updateData,
                condition: { id: jobId },
                returningClause: '*'
            }
        ];

        if (finalStatus === JobStatus.Cancelled) {
            operations.push(
                {
                    type: 'update',
                    table: 'jobs',
                    data: {trade_section_id: null},
                    condition: { id: jobId }
                }
            )
            const countJobsResult = await executeQuery(
                `SELECT COUNT(*)::int AS job_count FROM jobs 
         WHERE project_id = $1 AND trade_section_id = $2 AND id != $3 AND status != $4`,
                [projectId, tradeSectionId, jobId, JobStatus.Cancelled]
            );

            if (!countJobsResult.success) {
                return new LambdaResponse(400, buildError('DATABASE_ERROR', 'Failed to check trade usage'));
            }

            const jobCount = countJobsResult.data[0].job_count;

            if (jobCount === 0) {
                const ptsResult = await executeQuery(
                    `SELECT id FROM project_trade_sections WHERE project_id = $1 AND trade_section_id = $2 LIMIT 1`,
                    [projectId, tradeSectionId]
                );

                if (ptsResult.success && ptsResult.data.length > 0) {
                    const ptsId = ptsResult.data[0].id;

                    // Thêm delete assign + delete trade section vào operations
                    operations.push(
                        {
                            type: 'delete',
                            table: 'project_trade_section_assigns',
                            condition: { project_trade_section_id: ptsId }
                        },
                        {
                            type: 'delete',
                            table: 'project_trade_sections',
                            condition: { id: ptsId }
                        }
                    );
                }
            }
        }

        // Chạy transaction cuối cùng
        const txResult = await performTransaction(operations);

        if (!txResult.success) {
            console.error('Transaction failed:', txResult.error);
            return new LambdaResponse(400, buildError('DATABASE_ERROR', 'Failed to update job / cleanup trade'));
        }

        // Lấy jobData từ kết quả transaction
        const jobData = txResult.results?.[0]?.[0] || null;

        return new LambdaResponse(200, new ApiResponse(true, { data: jobData, report_id: reportId }, 'Job change status successfully'));

    } catch (error: any) {
        console.error('Job status change error occurred');
        if (error.name === 'ValidationError') {
            return new LambdaResponse(400, buildError('ENTITY_VALIDATION_FAILED', error.message));
        } else {
            return new LambdaResponse(400, buildError('LAMBDA_SERVICE_EXCEPTION', error.message));
        }
    }
};

async function invokeCreateReport(data: CreateReportData, header: APIGatewayProxyEventHeaders): Promise<string> {
    const functionName = process.env.REPORT_CREATE_FUNCTION_NAME;

    if (!functionName) {
        console.error('REPORT_CREATE_FUNCTION_NAME environment variable not set');
        throw new Error('Missing required environment variable');
    }

    console.log('Invoking report creation Lambda');

    try {
        const command = new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify({
                body: JSON.stringify(data),
                headers: header 
            })
        });

        const response = await getLambdaClient().send(command);

        if (response.Payload) {
            const payloadStr = new TextDecoder().decode(response.Payload);
            const result = JSON.parse(payloadStr);
            const resultBody = JSON.parse(result.body);

            if (resultBody.success && resultBody.data?.id) {
                console.log('Report created successfully');
                return resultBody.data?.id;
            } else {
                console.error('Report creation failed');
                throw new Error('Report creation failed');
            }
        } else {
            throw new Error('No response payload from Lambda');
        }
    } catch (error: any) {
        console.error('Lambda invocation failed');
        throw new Error(`Report creation failed: ${error.message}`);
    }
}