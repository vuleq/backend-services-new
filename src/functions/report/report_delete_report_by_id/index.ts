import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

export const handler = async (event: any) => {
  try {
    console.log('Event:', JSON.stringify(event));
    const reportId = event.params && event.params.path && event.params.path.reportId;
    if (!reportId) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'reportId path parameter is required.'));
    }
    const sql = `DELETE FROM report WHERE id = $1 RETURNING *`;
    const params = [reportId];
    const result = await executeQuery(sql, params);
    if (!result || !result.data || result.data.length === 0) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'Report not found or already deleted'));
    }
    return new LambdaResponse(200, new ApiResponse(true, result.data[0], 'Report deleted successfully'));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
