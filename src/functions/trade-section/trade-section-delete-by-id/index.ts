import { updateRecord } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  const tradeSectionId = event?.pathParameters?.id;

  if (!tradeSectionId) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Trade section id is required'));
  }

  try {
    const result = await updateRecord('trade_sections', {is_deleted : true} ,{ id: tradeSectionId });
    console.log('Result:', result);
    if (result.error) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'Trade section not found or already deleted!', result));
    }
    return new LambdaResponse(200, new ApiResponse(true, null, 'Trade section deleted successfully'));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
