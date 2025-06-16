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
    const queryParams = event.params && event.params.querystring ? event.params.querystring : {};

    const name = queryParams.name || null;
    let trade_section = queryParams.trade_section || null;
    const type = queryParams.type || null;
    const is_default = queryParams.is_default || null;
    const version = queryParams.version || null;
    const parent = queryParams.parent || null;
    const project_id = queryParams.project_id || null;
    const trade_id = queryParams.trade_id || null;
    const status = queryParams.status || null;
    const awrf_no = queryParams.awrf_no || null;
    const sub_code = queryParams.sub_code || null;
    const approver_id = queryParams.approver_id || null;
    const is_published = queryParams.is_published || null;
    const created_by = queryParams.created_by || null;

    let sql = `SELECT id, name, type, is_default, version, parent, project_id, trade_id, created_at, created_by, updated_at, updated_by, status, awrf_no, sub_code, approver_id, is_published, thumbnail, trade_section FROM report WHERE 1=1`;
    const params: any[] = [];
    let idx = 1;

    if (name) {
      sql += ` AND name ILIKE $${idx++}`;
      params.push(`%${name}%`);
    }
    if (trade_section !== null && trade_section !== undefined && trade_section !== "") {
      const tradeSections = trade_section.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (tradeSections.length === 1) {
        sql += ` AND trade_section = $${idx++}`;
        params.push(tradeSections[0]);
      } else if (tradeSections.length > 1) {
        const inParams = tradeSections.map(() => `$${idx++}`).join(', ');
        sql += ` AND trade_section IN (${inParams})`;
        params.push(...tradeSections);
      }
    }
    if (type !== null && type !== undefined && type !== "") {
      sql += ` AND type = $${idx++}`;
      params.push(type);
    }
    if (is_default !== null && is_default !== undefined && is_default !== "") {
      sql += ` AND is_default = $${idx++}`;
      params.push(is_default);
    }
    if (version !== null && version !== undefined && version !== "") {
      sql += ` AND version = $${idx++}`;
      params.push(version);
    }
    if (parent !== null && parent !== undefined && parent !== "") {
      sql += ` AND parent = $${idx++}`;
      params.push(parent);
    }
    if (project_id !== null && project_id !== undefined && project_id !== "") {
      sql += ` AND project_id = $${idx++}`;
      params.push(project_id);
    }
    if (trade_id !== null && trade_id !== undefined && trade_id !== "") {
      sql += ` AND trade_id = $${idx++}`;
      params.push(trade_id);
    }
    if (status !== null && status !== undefined && status !== "") {
      sql += ` AND status = $${idx++}`;
      params.push(status);
    }
    if (awrf_no !== null && awrf_no !== undefined && awrf_no !== "") {
      sql += ` AND awrf_no = $${idx++}`;
      params.push(awrf_no);
    }
    if (sub_code !== null && sub_code !== undefined && sub_code !== "") {
      sql += ` AND sub_code = $${idx++}`;
      params.push(sub_code);
    }
    if (approver_id !== null && approver_id !== undefined && approver_id !== "") {
      sql += ` AND approver_id = $${idx++}`;
      params.push(approver_id);
    }
    if (is_published !== null && is_published !== undefined && is_published !== "") {
      sql += ` AND is_published = $${idx++}`;
      params.push(is_published);
    }
    if (created_by !== null && created_by !== undefined && created_by !== ""){
      sql += ` AND created_by = $${idx++} `;
      params.push(created_by);
    }

    sql += ` ORDER BY trade_section ASC, updated_at DESC `;

    const result = await executeQuery(sql, params);
    return new LambdaResponse(200, new ApiResponse(true, result.data, 'Reports retrieved successfully'));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
