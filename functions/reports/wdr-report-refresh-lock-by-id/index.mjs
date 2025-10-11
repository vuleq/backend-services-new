import { executeQuery } from 'wdr-connect-db';
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
    const body = event.body ? JSON.parse(event.body) : null;
    const currentLockToken = body?.lockToken;
    const authHeader = event.headers?.Authorization || event.headers?.authorization;

    if (!id) {
        return new LambdaResponse(200, new ApiResponse(false, null, 'Missing reportId parameter', 10004));
    }

    if (!currentLockToken) {
        return new LambdaResponse(200, new ApiResponse(false, null, 'Missing lock token parameter', 10011));
    }

    if (!authHeader) {
        return new LambdaResponse(200, new ApiResponse(false, null, 'Missing authorization token', 10004));
    }

    try {
        const currentLogResult = await executeQuery(`SELECT end_time, lock_token, user_lock_id FROM report WHERE id = $1 AND type = $2`, [id, reportType['REPORT']]);
        if (!currentLogResult.success) {
            return new LambdaResponse(200, new ApiResponse(false, null, 'Database query error: ' + currentLogResult.error, 10007));
        }
        if (currentLogResult.data && currentLogResult.data.length === 0) {
            return new LambdaResponse(200, new ApiResponse(false, null, 'Report not found', 10006));
        }

        const currentLog = currentLogResult.data[0];
        let endTime = null;
        if (currentLog.end_time) {
            try {
                endTime = new Date(currentLog.end_time);
                if (isNaN(endTime.getTime())) endTime = null;
            } catch (error) {
                endTime = null;
            }
        }
        const lockToken = currentLog.lock_token;
        const lockUserId = currentLog.user_lock_id;
        const currentTime = new Date();
        const isLocked = endTime ? endTime > currentTime : false;

        // Prepare current lock user data for error responses
        const currentLockData = {
            id: id,
            end_time: currentLog.end_time,
            user_lock: await getUserById(currentLog.user_lock_id),
            type: reportType['REPORT']
        };

        if (!isLocked) {
            return new LambdaResponse(200, new ApiResponse(false, currentLockData, 'Report is not currently locked', 10013));
        }

        if (lockToken !== currentLockToken) {
            return new LambdaResponse(200, new ApiResponse(false, currentLockData, 'Lock token mismatch', 10012));
        }

        const payload = parseJWT(authHeader.replace('Bearer ', ''));

        if (!payload) {
            return new LambdaResponse(200, new ApiResponse(false, null, 'Invalid authorization token', 10005));
        }

        const userId = payload.sub;

        if (String(userId) !== String(lockUserId)) {
            return new LambdaResponse(200, new ApiResponse(false, currentLockData, 'User mismatch - not the lock owner', 10014));
        }

        // Get lock timeout from app_settings table
        const lockTimeoutResult = await executeQuery(
            `SELECT value FROM app_settings WHERE code = $1`, 
            ['REPORT_EDIT_SESSION_TIME']
        );
        
        let lockTimeoutMinutes = 15; // Default 15 minutes
        if (lockTimeoutResult.success && lockTimeoutResult.data && lockTimeoutResult.data.length > 0) {
            lockTimeoutMinutes = parseInt(lockTimeoutResult.data[0].value) || 15;
        } else if (!lockTimeoutResult.success) {
            return new LambdaResponse(200, new ApiResponse(false, null, 'App settings configuration error: ' + lockTimeoutResult.error, 10008));
        }
        
        // Calculate new end time based on current time + lock timeout
        const newEndTime = new Date(currentTime.getTime() + (lockTimeoutMinutes * 60 * 1000));

        // Keep the same lock token, just extend the end time
        const updateLockResult = await executeQuery(`UPDATE report SET end_time = $1 WHERE id = $2 AND type = $3 RETURNING id, name, type, lock_token, user_lock_id, end_time`,
            [newEndTime, id, reportType['REPORT']]);
        if (!updateLockResult.success) {
            return new LambdaResponse(200, new ApiResponse(false, null, 'Database update failed: ' + updateLockResult.error, 10010));
        }

        if (updateLockResult.data && updateLockResult.data.length === 0) {
            return new LambdaResponse(200, new ApiResponse(false, null, 'Report not found during update', 10006));
        }

        return new LambdaResponse(200, new ApiResponse(true, updateLockResult.data[0], 'Report lock refreshed successfully', 10015));

    } catch (error) {
        console.error('Error:', error);
        return new LambdaResponse(200, new ApiResponse(false, null, 'Internal server error: ' + error.message, 10003));
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