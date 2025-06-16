import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

export const handler = async (event: any) => {
  try {
    console.log('Raw Event:', JSON.stringify(event));

    let reportId =
      event?.pathParameters?.reportId ||
      event?.params?.path?.reportId ||
      event?.queryStringParameters?.reportId ||
      null;

    if (!reportId && event.body) {
      let body;
      try {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        reportId = body?.reportId;
      } catch (e) {
        // Not fatal here, just keep reportId as null if parsing fails
      }
    }

    if (!reportId) {
      console.warn('reportId missing from path/query/body:', event);
      return new LambdaResponse(400, new ApiResponse(false, null, 'reportId path parameter is required'));
    }

    const sql = `SELECT * FROM report WHERE id = $1`;
    const params = [reportId];

    const result = await executeQuery(sql, params);

    console.log('Query Result:', JSON.stringify(result));

    if (!result || !result.data || result.data.length === 0) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'Report not found'));
    }
    return new LambdaResponse(200, new ApiResponse(true, result.data[0], 'Report retrieved successfully'));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
