import { deleteRecord } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  const tradeSectionId = event?.pathParameters?.id;
  try {
    const result = await deleteRecord('trade_sections', { id: tradeSectionId });
    console.log('Result:', result);
    if (!result.success) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'Trade section not found or already deleted!', result));
    }
    return new LambdaResponse(200, new ApiResponse(true, null, 'Trade section deleted successfully'));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};
