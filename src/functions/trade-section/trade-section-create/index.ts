import { executeQuery, insertRecord } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';
import crypto from 'crypto';

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  const trade_section_name = JSON.parse(event.body || '{}')?.name;
  const userId = crypto.randomUUID();

  if (!trade_section_name || trade_section_name.trim() === '') {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Trade section name is required'));
  }

  try {
    const sql = 'SELECT * FROM trade_sections WHERE name = $1;';
    const params = [trade_section_name];
    const selectResult = await executeQuery(sql, params);

    if (selectResult.success && selectResult.rowCount && selectResult.rowCount > 0) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Trade section already exists!'));
    }

    if (!selectResult.success) {
      return new LambdaResponse(500, new ApiResponse(false, null, 'Error fetching trade section', selectResult.error));
    }

    const result = await insertRecord('trade_sections', { name: trade_section_name, created_by: userId, updated_by: userId });
    console.log('Result:', result);

    if (!result.success) {
      return new LambdaResponse(500, new ApiResponse(false, null, 'Trade section created failed!', result));
    }

    const createdData = (result as any).data ? (result as any).data : null;
    return new LambdaResponse(201, new ApiResponse(true, createdData, 'Trade section created successfully'));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
