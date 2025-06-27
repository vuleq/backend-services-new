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
      INSERT INTO report (
        name, trade_section, type, is_default, content, version, parent, project_id, trade_id,
        created_at, created_by, updated_at, updated_by, status, awrf_no, sub_code, approver_id, is_published, thumbnail
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
      )
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
      requestBody.created_at ?? now,
      requestBody.created_by ?? null,
      requestBody.updated_at ?? now,
      requestBody.updated_by ?? null,
      requestBody.status ?? null,
      requestBody.awrf_no ?? null,
      requestBody.sub_code ?? null,
      requestBody.approver_id ?? null,
      requestBody.is_published ?? false,
      requestBody.thumbnail ?? null,
    ];
    const result = await executeQuery(sql, params);
    return new LambdaResponse(201, new ApiResponse(true, result.data[0], 'Report created successfully'));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
