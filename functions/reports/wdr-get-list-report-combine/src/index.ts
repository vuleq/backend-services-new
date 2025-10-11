import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, ResponsePage, LambdaResponse } from 'wdr-models';
import { ERROR_CODES, buildError } from 'wdr-error-codes';

// Error code definitions:
// 20000: Successfully retrieved list reports
// 20001: Database connection or query error
// 20002: Missing required parameter: report_uuids
// 20003: Invalid report UUIDs - no valid reports found
// 20004: Failed to retrieve attachments
// 20005: Failed to retrieve photos
// 20006: Internal server error

const reportType = Object.freeze({
    TEMPLATE: 0,
    HEADER: 1,
    FOOTER: 2,
    REPORT: 3,
    COVER: 4
});

interface ReportItem {
    id: string;
    name: string;
    type: number;
    is_default: boolean;
    content: string;
    version: number;
    parent: string;
    project_id: string;
    job_id: string;
    created_at: string;
    created_by: string;
    updated_by: string;
    updated_at: string;
    status: string;
    awrf_no: string;
    sub_code: string;
    approver_id: string;
    is_published: boolean;
    thumbnail: string;
    trade_section: string;
    template_id: string;
    document_no: string;
    job_title: string;
    header_id: string;
    footer_id: string;
    footer_content: string;
    header_content: string;
    user_lock_id: string;
    end_time: string;
    header?: {
        id: string;
        content: string;
    };
    footer?: {
        id: string;
        content: string;
    };
}

interface AttachmentItem {
    id: string;
    job_id: string;
    file_url: string;
    original_filename: string;
    file_type: string;
    file_extension: string;
    file_size: number;
    upload_status: string;
    created_at: string;
    modified_at: string;
    created_by: string;
    modified_by: string;
    family_name: string;
    given_name: string;
    middle_name: string;
    job_title?: string; // Added job title to attachment interface
}

interface PhotoItem {
    name: string;
    s3url: string;
    type: string;
    job_id: string;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        console.log('Raw Event:', JSON.stringify(event));

        // Get query parameters
        const queryParams = event?.queryStringParameters || {};
        const reportUuidsParam = queryParams.report_uuids;
        const onlyAttachmentParam = queryParams.only_attachment;
        
        // Parse only_attachment parameter
        const onlyAttachment = onlyAttachmentParam === 'true';
        
        let reportUuids: string[] = [];
        
        if (reportUuidsParam) {
            // Support comma-separated string format
            if (typeof reportUuidsParam === 'string') {
                reportUuids = reportUuidsParam.split(',').map((uuid: string) => uuid.trim()).filter((uuid: string) => uuid.length > 0);
            }
        }

        // Validate report UUIDs parameter
        if (!reportUuids || reportUuids.length === 0) {
            const apiResponse = new ApiResponse(false, null, 'Missing required parameter: report_uuids (comma-separated UUIDs)', 20002);
            return new LambdaResponse(200, apiResponse);
        }

        console.log('Report UUIDs to fetch (in order):', reportUuids);
        console.log('Only attachment mode:', onlyAttachment);

        // Query reports to get job_ids (always needed for attachments)
        const reportsQuery = `
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
            WHERE id = ANY($1)
        `;
        const reportsParams = [reportUuids];

        console.log('Reports Query:', reportsQuery);
        console.log('Reports Params:', reportsParams);

        // Execute reports query
        const reportsResult = await executeQuery(reportsQuery, reportsParams);

        if (!reportsResult.success) {
            console.error('Database query failed for reports:', reportsResult.error);
            const apiResponse = new ApiResponse(false, null, 'Database connection or query error', 20001);
            return new LambdaResponse(200, apiResponse);
        }

        if (!reportsResult.data || reportsResult.data.length === 0) {
            console.log('No reports found for provided UUIDs');
            const apiResponse = new ApiResponse(false, null, 'Invalid report UUIDs - no valid reports found', 20003);
            return new LambdaResponse(200, apiResponse);
        }

        const reports: ReportItem[] = reportsResult.data;
        console.log(`Found ${reports.length} reports out of ${reportUuids.length} requested UUIDs`);

        let sortedReports: ReportItem[] = [];
        
        // Only process reports if not in only_attachment mode
        if (!onlyAttachment) {
            // Process reports - add header/footer objects for REPORT types (same logic as get by id)
            reports.forEach((report: ReportItem): void => {
                // Check if report is archived or soft deleted (same logic as get by id)
                if (report.status === 'DELETED' || report.status === 'ARCHIVED') {
                    // Skip this report - same behavior as get by id function
                    return;
                }

                // Apply header/footer return rule if type is REPORT (same logic as get by id)
                if (report.type === reportType.REPORT) {
                    if (report.header_id !== null && report.header_id !== undefined) {
                        report.header = {
                            id: report.header_id,
                            content: report.header_content
                        };
                    }
                    if (report.footer_id !== null && report.footer_id !== undefined) {
                        report.footer = {
                            id: report.footer_id,
                            content: report.footer_content
                        };
                    }
                }
            });

            // Filter out deleted/archived reports after processing
            const validReports: ReportItem[] = reports.filter((report: ReportItem): boolean => 
                report.status !== 'DELETED' && report.status !== 'ARCHIVED'
            );

            if (validReports.length === 0) {
                console.log('No valid reports found after filtering deleted/archived reports');
                const apiResponse = new ApiResponse(false, null, 'Invalid report UUIDs - no valid reports found', 20003);
                return new LambdaResponse(200, apiResponse);
            }

            // Sort reports according to the order of input parameters
            reportUuids.forEach((uuid: string) => {
                const foundReport = validReports.find((report: ReportItem) => report.id === uuid);
                if (foundReport) {
                    sortedReports.push(foundReport);
                }
            });

            console.log(`Sorted ${sortedReports.length} reports according to input order`);
        }

        // Extract unique job_ids from all reports (not just valid ones for only_attachment mode)
        const reportsForJobIds = onlyAttachment ? reports : sortedReports;
        const jobIds: string[] = [...new Set(reportsForJobIds
            .map((report: ReportItem): string => report.job_id)
            .filter((jobId: string): boolean => jobId !== null && jobId !== undefined)
        )];

        console.log('Job IDs found:', jobIds);

        let attachments: AttachmentItem[] = [];
        let photos: PhotoItem[] = [];

        // Get attachments if we have job_ids
        if (jobIds.length > 0) {
            // Query attachments with job title
            const attachmentsQuery = `
                SELECT 
                    ja.id,
                    ja.job_id,
                    ja.file_url,
                    ja.original_filename,
                    ja.file_type,
                    ja.file_extension,
                    ja.file_size,
                    ja.upload_status,
                    ja.created_at,
                    ja.modified_at,
                    ja.created_by,
                    ja.modified_by,
                    u.family_name,
                    u.given_name,
                    u.middle_name,
                    j.title as job_title
                FROM job_attachments ja
                LEFT JOIN users u ON ja.created_by = u.id
                LEFT JOIN jobs j ON ja.job_id = j.id
                WHERE ja.job_id = ANY($1)
                ORDER BY ja.created_at DESC
            `;
            const attachmentsParams = [jobIds];

            console.log('Fetching attachments with job titles for job IDs:', jobIds);

            const attachmentsResult = await executeQuery(attachmentsQuery, attachmentsParams);

            if (attachmentsResult.success) {
                attachments = attachmentsResult.data || [];
            } else {
                console.error('Failed to retrieve attachments:', attachmentsResult.error);
                // Continue without attachments
            }

            // Only get photos if not in only_attachment mode
            if (!onlyAttachment) {
                // Query photos
                const photosQuery = `
                    SELECT 
                        file_name as name, 
                        s3_url as s3url, 
                        file_type as type,
                        job_id
                    FROM files 
                    WHERE job_id = ANY($1)
                    ORDER BY created_at DESC
                `;
                const photosParams = [jobIds];

                console.log('Fetching photos for job IDs:', jobIds);

                const photosResult = await executeQuery(photosQuery, photosParams);

                if (photosResult.success) {
                    photos = photosResult.data || [];
                } else {
                    console.error('Failed to retrieve photos:', photosResult.error);
                    // Continue without photos
                }
            }
        }

        // Prepare response based on mode
        let responseData: any;
        
        if (onlyAttachment) {
            responseData = {
                list_attachment: attachments
            };
            console.log('Only attachment mode - Response Summary:', {
                requested_uuids: reportUuids.length,
                found_reports: reports.length,
                attachments_count: attachments.length,
                job_ids_count: jobIds.length
            });
        } else {
            responseData = {
                list_report: sortedReports,
                list_attachment: attachments,
                list_photo: photos
            };
            console.log('Full mode - Response Summary:', {
                requested_uuids: reportUuids.length,
                found_reports: reports.length,
                sorted_reports: sortedReports.length,
                attachments_count: attachments.length,
                photos_count: photos.length,
                job_ids_count: jobIds.length
            });
        }

        const apiResponse = new ApiResponse(true, responseData, 'Successfully retrieved list reports', 20000);
        return new LambdaResponse(200, apiResponse);

    } catch (error: any) {
        console.error('Unexpected error in get list reports:', error);
        const apiResponse = new ApiResponse(false, null, 'Internal server error', 20006);
        return new LambdaResponse(200, apiResponse);
    }
};