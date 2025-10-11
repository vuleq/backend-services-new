import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery, performTransaction, Operation } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { buildError } from 'wdr-error-codes';
import { isValidUUID, isValidCognitoSub, getLoginUserInfo } from 'wdr-common-utils';

enum ProjectStatus {
    'Not started' = 0,
    Started,
    Completed,
    Closed,
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('Receive event', event);

    try {
        const projectId = event.pathParameters?.id;

        if (!projectId || !isValidUUID(projectId)) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'Project id is required'));
        }

        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
        const requestHeader = event.headers;
        const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

        if (!loginUserId || !isValidCognitoSub(loginUserId)) {
            return new LambdaResponse(400, buildError('INVALID_REQUEST', "No user logined"));
        }

        // Check if project exists and completed
        const selectQuery = `SELECT status FROM projects WHERE id = $1`;
        const selectResult = await executeQuery(selectQuery, [projectId]);

        if (!selectResult.success) {
            return new LambdaResponse(400, buildError('DATABASE_ERROR', 'Failed to fetch project'));
        }

        if (!selectResult.data || selectResult.data.length === 0) {
            return new LambdaResponse(400, buildError('RESOURCE_NOT_FOUND', 'Project not found'));
        }

        const currentStatus = selectResult.data[0].status;
        if (currentStatus !== ProjectStatus.Completed) {
            return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Only complete project is allow to update feeddback'));
        }


        const feedback = body.feedback;
        if (!feedback || !(typeof feedback === 'string') || feedback.trim() === '') {
            return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Feedback is required when completing the project'));
        }

        const updateData: {
            updated_by: string;
            updated_date: string;
            feedback: string;
        } = {
            updated_by: loginUserId,
            updated_date: new Date().toISOString(),
            feedback: body.feedback
        }

        const operations: Operation[] = [
            {
                type: 'update',
                data: updateData,
                table: 'projects',
                condition: { id: projectId },
                returningClause: 'feedback'
            }
        ];

        // use performTransaction for now to support history feature late
        const result = await performTransaction(operations);
        if (result.success) {
            const feedbackData = result.results?.[0][0];

            return new LambdaResponse(200, new ApiResponse(true, feedbackData, 'Update project feedback successfully'));
        }

        return new LambdaResponse(400, buildError('DATABASE_ERROR', 'Failed to update project feedback'));
    } catch (error: any) {
        console.error('Project update feedback error:', error.name || 'Unknown error');
        return new LambdaResponse(400, buildError('LAMBDA_SERVICE_EXCEPTION', error.message));
    }
};