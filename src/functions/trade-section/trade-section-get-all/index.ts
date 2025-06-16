import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

export const handler = async (event: any) => {
  try {
    let selectSql = 'SELECT * FROM trade_sections;';
    let selectParams: any[] = [];
    const result = await executeQuery(selectSql, selectParams);
    return new LambdaResponse(200, new ApiResponse(true, result.data));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
