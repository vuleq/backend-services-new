import { executeQuery, logAPIError, logDatabaseError, performTransaction } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { isValidCognitoSub, getLoginUserInfo } from 'wdr-common-utils';

const reportType = Object.freeze({
    TEMPLATE: 0,
    HEADER: 1,
    FOOTER: 2,
    REPORT: 3,
    COVER: 4
});

const wdrStatusEnum = {
    'Not started': 0,
    Draft: 1,
    'Pre review': 2,
    'HOD review': 3,
    'SRM review': 4,
    Completed: 5
}

export const handler = async (event) => {
    try {
        console.log('Event:', JSON.stringify(event));
        const reportId = event.pathParameters?.reportId;
        if (!reportId) {
            await logAPIError('Missing required parameter: reportId');
            return new LambdaResponse(200, new ApiResponse(false, null, 'Missing required parameter: reportId', 10004));
        }

        // Get request headers and query parameters
        const requestHeader = event.headers || {};
        const queryParams = event.queryStringParameters || {};
        let lockToken = queryParams.lockToken || queryParams.LockToken;
        const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

        if (!loginUserId || !isValidCognitoSub(loginUserId)) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'User not logined'));
        }

        // Fetch report info first
        const fetchSql = `SELECT id, type, user_lock_id, end_time, lock_token, job_id FROM report WHERE id = $1`;
        const fetchResult = await executeQuery(fetchSql, [reportId]);
        if (!fetchResult.success || !fetchResult.data[0]) {
            await logDatabaseError('Report not found or already deleted');
            return new LambdaResponse(200, new ApiResponse(false, null, 'Report not found or already deleted', 10006));
        }
        const report = fetchResult.data[0];
        const currentTime = new Date();

        // Proceed to delete
        const sql = `DELETE FROM report WHERE id = $1 RETURNING *`;
        const params = [reportId];
        const operations = [{
            type: 'query',
            queryText: sql,
            params: params,
            returningClause: '*'
        }];

        // Strict lock check for REPORT type
        if (report.type === reportType.REPORT) {
            if (report.end_time && new Date(report.end_time) > currentTime) {
                // Report is locked
                const currentLockData = {
                    id: reportId,
                    end_time: report.end_time,
                    user_lock: await getUserById(report.user_lock_id),
                    type: reportType['REPORT']
                };
                if (!lockToken) {
                    await logAPIError('Missing lock token');
                    return new LambdaResponse(200, new ApiResponse(false, currentLockData, 'Report delete denied - missing lock token', 10025));
                }
                if (lockToken !== report.lock_token) {
                    await logAPIError('Lock token mismatch');
                    return new LambdaResponse(200, new ApiResponse(false, currentLockData, 'Lock token mismatch', 10012));
                }
                if (loginUserId !== report.user_lock_id) {
                    await logAPIError('Report is currently locked by another user');
                    return new LambdaResponse(200, new ApiResponse(false, currentLockData, 'Report is currently locked by another user', 10024));
                }
            }

            if (report.job_id) {
                operations.push({
                    type: 'update',
                    table: 'jobs',
                    data: { wdr_status: wdrStatusEnum['Not started'] },
                    condition: { id: report.job_id }
                });
            }
        }

        const result = await performTransaction(operations);

        if (!result.success) {
            await logDatabaseError('Database delete operation failed');
            return new LambdaResponse(200, new ApiResponse(false, null, 'Database delete operation failed', 10010));
        }

        const reportData = result.results?.[0] ? result.results[0][0] : null;

        if (!reportData) {
            await logDatabaseError('Report not found or already deleted');
            return new LambdaResponse(200, new ApiResponse(false, null, 'Report not found or already deleted', 10006));
        }
        return new LambdaResponse(200, new ApiResponse(true, reportData, 'Report deleted successfully', 10023));
    } catch (error) {
        console.error('Error:', error);
        await logAPIError('Internal server error');
        return new LambdaResponse(200, new ApiResponse(false, null, 'Internal server error', 10003));
    }
};


const getUserById = async (userId) => {
    try {
        const sql = `SELECT id, name, email FROM users WHERE id = $1`;
        const params = [userId];
        const result = await executeQuery(sql, params);
        return new Users(result.data[0].id, result.data[0].name, result.data[0].email);
    } catch (error) {
        console.error('Error:', error);
        return null;
    }
}

class Users {
    constructor(id, name, email) {
        this.id = id;
        this.name = name;
        this.email = email;
    }
}