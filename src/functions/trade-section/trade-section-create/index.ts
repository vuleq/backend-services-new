import { executeQuery, insertRecord } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';
import crypto from 'crypto';

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  const trade_section_name = event.requestBody.name;
  const userId = crypto.randomUUID();
  try {
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
