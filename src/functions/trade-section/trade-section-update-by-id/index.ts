import { updateRecord } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';
import crypto from 'crypto';

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  const trade_section_name = JSON.parse(event.body || '{}')?.name;
  const trade_section_id = event?.pathParameters?.id;

  if (!trade_section_name) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Trade section name is required'));
  }

  if (!trade_section_id) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Trade section id is required'));
  }

  const userId = crypto.randomUUID();
  console.log('Trade section name:', trade_section_name);
  console.log('trade_section_id:', trade_section_id);

  try {
    const result = await updateRecord('trade_sections', { name: trade_section_name, updated_by: userId }, { id: trade_section_id });
    console.log('Result:', result);
    if (result.success && result.rowCount && result.rowCount > 0) {
      return new LambdaResponse(200, new ApiResponse(true, result.data, 'Trade section update successfully'));
    }
    return new LambdaResponse(500, new ApiResponse(false, null, 'Trade section update failed!', result.error));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
