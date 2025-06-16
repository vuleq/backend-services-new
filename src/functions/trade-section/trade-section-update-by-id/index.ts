import { updateRecord } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';
import crypto from 'crypto';

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  const trade_section_name = event.requestBody.name;
  const userId = crypto.randomUUID();
  const trade_section_id = event.id;
  console.log('Trade section name:', trade_section_name);
  console.log('trade_section_id:', trade_section_id);
  try {
    const result = await updateRecord('trade_sections', { name: trade_section_name, updated_by: userId }, { id: trade_section_id });
    console.log('Result:', result);
    if (!result.success) {
      return new LambdaResponse(500, new ApiResponse(false, null, 'Trade section update failed!', result.error));
    }
    return new LambdaResponse(200, new ApiResponse(true, null, 'Trade section update successfully'));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
