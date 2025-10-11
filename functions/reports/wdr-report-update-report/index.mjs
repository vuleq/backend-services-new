import { executeQuery, performTransaction } from 'wdr-connect-db';
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
// 10019: Successfully retrieved report
// 10020: Invalid report ID format
// 10021: Report access denied
// 10022: Report is archived or deleted
// 10023: Successfully updated report
// 10024: Report is currently locked by another user
// 10025: Report update denied - missing lock token
// 10026: Report update denied - report is completed

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

const DEFAULT_UPDATED_BY = "00000000-0000-0000-0000-000000000000";

class Users {
    constructor(id, name, email) {
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

// Helper function to get Lock Report info, return true if token, end_time, user valid; else false.
function getLockReportInfo(reportId, lockToken, userId, reportData) {
    try {
        if (!reportData) {
            console.error('No report data found');
            return false;
        }
        const currentTime = new Date();
        if (
            reportData.lock_token === lockToken &&
            reportData.user_lock_id === userId &&
            reportData.end_time && new Date(reportData.end_time) > currentTime
        ) {
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error getting lock report info:', error);
        return false;
    }
}

export const handler = async (event) => {
    try {
        console.log('Event:', JSON.stringify(event));

        const reportId = (event.pathParameters && event.pathParameters.reportId) ||
            (event.params && event.params.path && event.params.path.reportId);

        // Validate reportId from path
        if (!reportId) {
            return new LambdaResponse(200, new ApiResponse(false, null, 'Missing required parameter: reportId', 10004));
        }

        // Get request headers and query parameters
        const requestHeader = event.headers || {};
        const queryParams = event.queryStringParameters || {};
        let userId = DEFAULT_UPDATED_BY;
        let lockToken = queryParams.lockToken || queryParams.LockToken;

        if (requestHeader) {
            let token = requestHeader["Authorization"] || requestHeader["authorization"];
            // Parse JWT token
            if (token) {
                token = token.replace('Bearer ', '');
                const payload = parseJWT(token);
                console.log('JWT Payload:', payload);
                if (!payload) {
                    return new LambdaResponse(200, new ApiResponse(false, null, 'Invalid authorization token format or content', 10005));
                }
                userId = payload?.sub;
            }
        }

        // Parse request body
        let requestBody = event["body-json"] || event.body || {};
        if (typeof requestBody === 'string') {
            try {
                requestBody = JSON.parse(requestBody);
            } catch (e) {
                return new LambdaResponse(200, new ApiResponse(false, null, 'Invalid JSON in request body', 10003));
            }
        }

        // Basic validation
        if (!requestBody || Object.keys(requestBody).length === 0) {
            return new LambdaResponse(200, new ApiResponse(false, null, 'Request body is required', 10004));
        }

        // Required fields validation - only name, trade_section, and type are mandatory
        if (!requestBody.name || requestBody.trade_section === undefined || requestBody.type === undefined) {
            return new LambdaResponse(200, new ApiResponse(false, null, 'name, trade_section, and type are required', 10004));
        }

        // Validate report type
        if (!Object.values(reportType).includes(requestBody.type)) {
            return new LambdaResponse(200, new ApiResponse(false, null, 'Invalid report type', 10003));
        }

        // Check if report exists and get current lock status and type
        const lockCheckSql = `SELECT user_lock_id, end_time, lock_token, type, is_published, job_id FROM report WHERE id = $1`;
        const lockResult = await executeQuery(lockCheckSql, [reportId]);

        if (!lockResult.success) {
            return new LambdaResponse(200, new ApiResponse(false, null, 'Database connection or query error', 10007));
        }

        if (!lockResult.data || lockResult.data.length === 0) {
            return new LambdaResponse(200, new ApiResponse(false, null, 'Report not found in database', 10006));
        }

        const reportData = lockResult.data[0];
        const currentTime = new Date();

        // Only check lock token for REPORT type (type = 3)
        if (reportData.type === reportType.REPORT) {
            if (reportData.is_published) {
                return new LambdaResponse(200, new ApiResponse(false, null, 'Report update denied - report is completed', 10026));
            }
            const currentLockData = {
                id: reportId,
                end_time: reportData.end_time,
                user_lock: await getUserById(reportData.user_lock_id),
                type: reportType['REPORT']
            };
            // Check if report is currently locked
            if (reportData.end_time && new Date(reportData.end_time) > currentTime) {
                // Prepare current lock user data for error responses


                // Report is locked, check if lock token is provided
                if (!lockToken) {
                    return new LambdaResponse(200, new ApiResponse(false, currentLockData, 'Report update denied - missing lock token', 10025));
                }

                // Verify lock token matches
                if (lockToken !== reportData.lock_token) {
                    return new LambdaResponse(200, new ApiResponse(false, currentLockData, 'Lock token mismatch', 10012));
                }

                // Verify user owns the lock
                if (userId !== reportData.user_lock_id) {
                    return new LambdaResponse(200, new ApiResponse(false, currentLockData, 'Report is currently locked by another user', 10024));
                }
            }

            console.log(getLockReportInfo(reportId, lockToken, userId, reportData));


            if (!getLockReportInfo(reportId, lockToken, userId, reportData)) {
                return new LambdaResponse(200, new ApiResponse(false, currentLockData, 'Invalid lock information', 10026));
            }
        }
        // For other types (TEMPLATE, HEADER, FOOTER, COVER), no lock validation is required

        // Validate name uniqueness (only if name is being changed)
        if (requestBody.name !== reportData.name) {
            if (requestBody.type === reportType.REPORT) {
                const checkNameSql = `SELECT id FROM report WHERE name = $1 AND type = $2 AND project_id = $3 AND trade_section = $4 AND id != $5 LIMIT 1`;
                const checkNameParams = [requestBody.name, requestBody.type, requestBody.project_id, requestBody.trade_section, reportId];
                const nameExists = await executeQuery(checkNameSql, checkNameParams);
                if (nameExists.data[0]) {
                    return new LambdaResponse(200, new ApiResponse(false, null, 'Report name already exists in this project and trade section', 10027));
                }
            } else if (requestBody.type === reportType.TEMPLATE) {
                const checkNameSql = `SELECT id FROM report WHERE name = $1 AND type = $2 AND trade_section = $3 AND id != $4 LIMIT 1`;
                const checkNameParams = [requestBody.name, requestBody.type, requestBody.trade_section, reportId];
                const nameExists = await executeQuery(checkNameSql, checkNameParams);
                if (nameExists.data[0]) {
                    return new LambdaResponse(200, new ApiResponse(false, null, 'Report name already exists in this type and trade section', 10027));
                }
            }
        }

        // Validate is_default setting
        if (requestBody.is_default === true) {
            if (requestBody.type === reportType.REPORT) {
                return new LambdaResponse(200, new ApiResponse(false, null, 'REPORT type cannot be set as default', 10028));
            } else if (requestBody.type === reportType.HEADER || requestBody.type === reportType.FOOTER || requestBody.type === reportType.COVER) {
                // For HEADER, FOOTER, and COVER, check only by type (no trade_section)
                const checkDefaultSql = `SELECT id FROM report WHERE is_default = true AND type = $1 AND id != $2 LIMIT 1`;
                const checkDefaultParams = [requestBody.type, reportId];
                const defaultExists = await executeQuery(checkDefaultSql, checkDefaultParams);
                if (defaultExists.data[0]) {
                    const typeLabels = {
                        [reportType.HEADER]: 'header',
                        [reportType.FOOTER]: 'footer',
                        [reportType.COVER]: 'cover'
                    };
                    const typeLabel = typeLabels[requestBody.type];
                    
                    // Update existing default to false before updating current report
                    const updateDefaultSql = `UPDATE report SET is_default = false WHERE is_default = true AND type = $1 AND id != $2`;
                    await executeQuery(updateDefaultSql, [requestBody.type, reportId]);
                    console.log(`Updated existing default ${typeLabel} to non-default`);
                }
            } else if (requestBody.type === reportType.TEMPLATE) {
                // For TEMPLATE type, check by type and trade_section
                const checkDefaultSql = `SELECT id FROM report WHERE is_default = true AND type = $1 AND trade_section = $2 AND id != $3 LIMIT 1`;
                const checkDefaultParams = [requestBody.type, requestBody.trade_section, reportId];
                const defaultExists = await executeQuery(checkDefaultSql, checkDefaultParams);
                if (defaultExists.data[0]) {
                    // Update existing default to false before updating current report
                    const updateDefaultSql = `UPDATE report SET is_default = false WHERE is_default = true AND type = $1 AND trade_section = $2 AND id != $3`;
                    await executeQuery(updateDefaultSql, [requestBody.type, requestBody.trade_section, reportId]);
                    console.log(`Updated existing default template for trade_section ${requestBody.trade_section} to non-default`);
                }
            }
        }

        const now = new Date().toISOString();

        // Prepare SQL for update
        const sql = `
          UPDATE report SET
            name = $1,
            trade_section = $2,
            type = $3,
            is_default = $4,
            content = $5,
            version = $6,
            parent = $7,
            project_id = $8,
            job_id = $9,
            updated_at = $10,
            updated_by = $11,
            status = $12,
            awrf_no = $13,
            sub_code = $14,
            approver_id = $15,
            is_published = $16,
            thumbnail = $17,
            header_id = $18,
            header_content = $19,
            footer_id = $20,
            footer_content = $21
          WHERE id = $22
          RETURNING *
        `;

        const params = [
            requestBody.name,
            requestBody.trade_section,
            requestBody.type,
            requestBody.is_default ?? false,
            requestBody.content ?? null,
            requestBody.version ?? null,
            requestBody.parent ?? null,
            requestBody.project_id ?? null,
            requestBody.job_id ?? null,
            now,
            requestBody.updated_by ?? DEFAULT_UPDATED_BY,
            requestBody.status ?? null,
            requestBody.awrf_no ?? null,
            requestBody.sub_code ?? null,
            requestBody.approver_id ?? null,
            requestBody.is_published ?? false,
            requestBody.thumbnail ?? null,
            requestBody.header_id ?? null,
            requestBody.header_content ?? null,
            requestBody.footer_id ?? null,
            requestBody.footer_content ?? null,
            reportId
        ];

        const operations = [{
            type: 'query',
            queryText: sql,
            params: params,
            returningClause: '*'
        }]

        if (requestBody.type === reportType.REPORT && requestBody.is_published) {
            operations.push({
                type: 'update',
                table: 'jobs',
                data: { wdr_status: wdrStatusEnum['Completed'] },
                condition: { id: reportData.job_id },
            });
        }

        const result = await performTransaction(operations);

        if (!result.success) {
            console.error('Transaction failed:', result.error);
            return new LambdaResponse(200, new ApiResponse(false, null, 'Database update operation failed', 10010));
        }

        const data = result.results?.[0] ? result.results[0][0] : null;
        console.log(data);
        if (data.header_id !== null && data.header_id !== undefined) {
            data.header = {
                id: data.header_id,
                content: data.header_content
            };
        }

        if (data.footer_id !== null && data.footer_id !== undefined) {
            data.footer = {
                id: data.footer_id,
                content: data.footer_content
            };
        }

        return new LambdaResponse(200, new ApiResponse(true, data, 'Successfully updated report', 10023));

    } catch (error) {
        console.error('Unexpected error in update report:', error);
        return new LambdaResponse(200, new ApiResponse(false, null, 'Internal server error', 10003));
    }
};