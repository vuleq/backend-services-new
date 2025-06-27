import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

const reportType = Object.freeze({
  TEMPLATE: 0,
  COVER: 1,
  HEADER_FOOTER: 2,
  REPORT: 3
});

export const handler = async (event: any) => {
  try {
    console.log('Event:', JSON.stringify(event));
    const reportId = (event.pathParameters && event.pathParameters.reportId) ||
      (event.params && event.params.path && event.params.path.reportId);
    if (!reportId) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'reportId path parameter is required'));
    }
    const requestBody = event["body-json"] || {};
    if (!requestBody || Object.keys(requestBody).length === 0) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Request body is required'));
    }
    if (!requestBody.name || requestBody.trade_section === undefined || requestBody.type === undefined) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'name, trade_section, type are required.'));
    }
    if (!Object.values(reportType).includes(requestBody.type)) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid report type'));
    }
    const now = new Date().toISOString();
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
        trade_id = $9,
        updated_at = $10,
        updated_by = $11,
        status = $12,
        awrf_no = $13,
        sub_code = $14,
        approver_id = $15,
        is_published = $16,
        thumbnail = $17
      WHERE id = $18
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
      requestBody.trade_id ?? null,
      now,
      requestBody.updated_by ?? null,
      requestBody.status ?? null,
      requestBody.awrf_no ?? null,
      requestBody.sub_code ?? null,
      requestBody.approver_id ?? null,
      requestBody.is_published ?? false,
      requestBody.thumbnail ?? null,
      reportId
    ];
    const result = await executeQuery(sql, params);
    if (!result || !result.data || result.data.length === 0) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'Report not found or not updated'));
    }
    return new LambdaResponse(200, new ApiResponse(true, result.data[0], 'Report updated successfully'));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
