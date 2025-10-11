import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

export const handler = async (event) => {
  console.log('Receive Event:', JSON.stringify(event, null, 2));

  try {
    const selectResult = await executeQuery('SELECT DISTINCT ts.id, ts.name FROM jobs j JOIN trade_sections ts ON ts.id = j.trade_section_id ');

    if (!selectResult.success) {
        return new LambdaResponse(400, new ApiResponse(false, null, 'Error when get trade sections list'));
    }

    return new LambdaResponse(200, new ApiResponse(true, selectResult.data));
  } catch (error) {
    console.error('Error:', error);
    return new LambdaResponse(1301, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};