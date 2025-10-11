import { executeQuery, logDatabaseError, logAPIError } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

// Error code definition:
// 10000: Successfully locked report
// 10001: Failed to lock report due to same user already has lock
// 10002: Failed to lock report due to other user locked
// 10003: Failed to lock report due to unknown error
// 10004: Missing required parameters (reportId, authorization token)
// 10005: Invalid authorization token format or content
// 10006: Report not found in database
// 10007: Database connection or query error
// 10008: App settings configuration error (REPORT_EDIT_SESSION_TIME not found)
// 10009: JWT token generation failed
// 10010: Database update operation failed
// 10011: Missing lock token parameter
// 10012: Lock token mismatch (provided token doesn't match stored token)
// 10013: Report is not currently locked
// 10014: User mismatch (user trying to refresh is not the lock owner)
// 10015: Successfully refreshed lock
// 10016: Successfully unlocked report
// 10017: Force unlock denied - user mismatch
// 10018: Invalid lock token format

class Users {
    constructor(id, name, email){
        this.id = id;
        this.name = name;
        this.email = email;
    }
}

const getUserById = async (userId) => {
    try {
        const sql = `SELECT id, name, email FROM users WHERE id = $1`;
        const params = [userId];
        const result = await executeQuery(sql, params);
        return new Users(result.data[0].id, result.data[0].name, result.data[0].email);
    } catch (error) {
        console.error('Error:', error);
        await logDatabaseError('Database query error');
        return null;
    }
}

const reportType = Object.freeze({
    TEMPLATE: 0,
    HEADER: 1,
    FOOTER: 2,
    REPORT: 3,
    COVER: 4
});

export const handler = async (event) => {
    console.log('Receive Event:', event);
    const id = event.pathParameters?.reportId;
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    
    // Get lock token from query params or body
    let lockTokenInput = event.queryStringParameters?.lockToken;
    let force = event.queryStringParameters?.force === 'true';
    
    if (event.body) {
        try {
            const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
            if (!lockTokenInput) lockTokenInput = body.lockToken;
            if (!force) force = body.force === true;
        } catch (e) {
            // Ignore JSON parse errors
            await logAPIError('JSON parse errors');
        }
    }

    if (!id) {
        await logAPIError('Missing reportId parameter');
        return new LambdaResponse(200, new ApiResponse(false, null, 'Missing reportId parameter', 10004));
    }

    if (!authHeader) {
        await logAPIError('Missing authorization token');
        return new LambdaResponse(200, new ApiResponse(false, null, 'Missing authorization token', 10004));
    }

    // Check if lock token is provided when not forcing
    if (!force && !lockTokenInput) {
        await logAPIError('Missing lock token parameter');
        return new LambdaResponse(200, new ApiResponse(false, null, 'Missing lock token parameter', 10011));
    }

    try {
        const currentTime = new Date();

        const currentLogResult = await executeQuery(`SELECT end_time, lock_token, user_lock_id FROM report WHERE id = $1 AND type = $2`, [id, reportType['REPORT']]);
        if (!currentLogResult.success) {
            await logDatabaseError('Database query error');
            return new LambdaResponse(200, new ApiResponse(false, null, 'Database query error: ' + currentLogResult.error, 10007));
        }
        if (currentLogResult.data && currentLogResult.data.length === 0) {
            await logDatabaseError('Report not found');
            return new LambdaResponse(200, new ApiResponse(false, null, 'Report not found', 10006));
        }

        const currentLog = currentLogResult.data[0];
        const endTime = new Date(currentLog.end_time);
        const lockToken = currentLog.lock_token;
        const lockUserId = currentLog.user_lock_id;
        const isLocked = endTime ? endTime > currentTime : false;

        // Prepare lock data with user information for error responses
        const lockData = {
            id: id,
            end_time: currentLog.end_time,
            user_lock: await getUserById(currentLog.user_lock_id),
            type: reportType['REPORT']
        };

        if (!isLocked) {
            await logAPIError('Report is not locked');
            return new LambdaResponse(200, new ApiResponse(false, lockData, 'Report is not locked', 10010));
        }

        // Parse authorization token to get current user
        const authToken = authHeader.replace('Bearer ', '');
        const authPayload = parseJWT(authToken);
        if (!authPayload) {
            await logAPIError('Invalid authorization token');
            return new LambdaResponse(200, new ApiResponse(false, null, 'Invalid authorization token', 10005));
        }
        const currentUserId = authPayload.sub;

        // If force is true, check if current user matches lock user
        if (force) {
            if (currentUserId !== lockUserId) {
                await logAPIError('Force unlock denied - user mismatch');
                return new LambdaResponse(200, new ApiResponse(false, lockData, 'Force unlock denied: user mismatch', 10013));
            }
        } else {
            // Normal unlock - validate lock token
            if (lockToken !== lockTokenInput) {
                await logAPIError('Unable to unlock: the lock token mismatch');
                return new LambdaResponse(200, new ApiResponse(false, lockData, 'Unable to unlock: the lock token mismatch', 10014));
            }
        }

        const updateLockResult = await executeQuery(`UPDATE report SET end_time = $1, lock_token = $2, user_lock_id = $3 WHERE id = $4 AND type = $5 RETURNING id, name, type, lock_token, user_lock_id, end_time`,
            [null, null, null, id, reportType['REPORT']]);
        if (!updateLockResult.success) {
            await logDatabaseError('Error updating lock');
            return new LambdaResponse(200, new ApiResponse(false, null, 'Error updating lock: ' + updateLockResult.error, 10007));
        }

        if (updateLockResult.data && updateLockResult.data.length === 0) {
            await logDatabaseError('Report not found');
            return new LambdaResponse(200, new ApiResponse(false, null, 'Report not found', 10006));
        }

        const message = force ? 'Report force unlocked successfully' : 'Unlocked report successfully';
        return new LambdaResponse(200, new ApiResponse(true, updateLockResult.data[0], message, 10000));

    } catch (error) {
        console.error('Error:', error);
        await logAPIError('Internal server error');
        return new LambdaResponse(200, new ApiResponse(false, null, 'Internal server error: ' + error.message, 10001));
    }
};

// Helper function to parse JWT without verification (for payload extraction)
function parseJWT(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const payload = parts[1];
        const decoded = Buffer.from(payload, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (error) {
        console.error('JWT parse error:', error);
        return null;
    }
}