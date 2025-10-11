import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, ResponsePage, LambdaResponse } from 'wdr-models';
import { ERROR_CODES, buildError } from 'wdr-error-codes';

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

const reportType = Object.freeze({
    TEMPLATE: 0,
    HEADER: 1,
    FOOTER: 2,
    REPORT: 3,
    COVER: 4
});

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        console.log('Raw Event:', JSON.stringify(event));

        // Support multiple event shapes (API Gateway proxy, custom, etc.)
        let reportId =
            event?.pathParameters?.reportId ||
            event?.queryStringParameters?.reportId || // fallback: sometimes sent as query param
            null;

        // Defensive: also parse from body if needed
        if (!reportId && event.body) {
            let body;
            try {
                body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
                reportId = body?.reportId;
            } catch (e) {
                // Not fatal here, just keep reportId as null if parsing fails
            }
        }

        // Validate reportId
        if (!reportId) {
            console.warn('reportId missing from path/query/body:', event);
            const apiResponse = new ApiResponse(false, null, 'Missing required parameter: reportId', 10004);
            return new LambdaResponse(200, apiResponse);
        }

        // Validate reportId format (should be a valid number/UUID)
        if (isNaN(Number(reportId)) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reportId)) {
            const apiResponse = new ApiResponse(false, null, 'Invalid report ID format', 10020);
            return new LambdaResponse(200, apiResponse);
        }

        // Prepare SQL - select only needed fields
        const sql = `
            SELECT 
                id, 
                name, 
                type, 
                is_default, 
                content, 
                version, 
                parent, 
                project_id, 
                job_id, 
                created_at, 
                created_by, 
                updated_by, 
                updated_at, 
                status, 
                awrf_no, 
                sub_code, 
                approver_id, 
                is_published, 
                thumbnail, 
                trade_section, 
                template_id, 
                document_no, 
                job_title, 
                header_id, 
                footer_id, 
                footer_content, 
                header_content, 
                user_lock_id, 
                end_time
            FROM report 
            WHERE id = $1
        `;
        const params = [reportId];

        const result = await executeQuery(sql, params);

        // Logging for debug
        console.log('Query Result:', JSON.stringify(result));

        if (!result.success) {
            console.error('Database query failed:', result.error);
            const apiResponse = new ApiResponse(false, null, 'Database connection or query error', 10007);
            return new LambdaResponse(200, apiResponse);
        }

        if (!result.data || result.data.length === 0) {
            const apiResponse = new ApiResponse(false, null, 'Report not found in database', 10006);
            return new LambdaResponse(200, apiResponse);
        }
        
        const data = result.data[0];

        // Check if report is archived or soft deleted (if such fields exist)
        if (data.is_deleted === true || data.status === 'DELETED' || data.status === 'ARCHIVED') {
            const apiResponse = new ApiResponse(false, null, 'Report is archived or deleted', 10022);
            return new LambdaResponse(200, apiResponse);
        }

        // Apply header/footer return rule if type is REPORT
        if (data.type === reportType.REPORT) {
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
        }
        
        const apiResponse = new ApiResponse(true, data, 'Successfully retrieved report', 10019);
        return new LambdaResponse(200, apiResponse);
    } catch (error: any) {
        console.error('Unexpected error in get report by id:', error);
        const apiResponse = new ApiResponse(false, null, 'Internal server error', 10003);
        return new LambdaResponse(200, apiResponse);
    }
};
