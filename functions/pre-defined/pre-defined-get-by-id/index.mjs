import { executeQuery, logAPIError, logDatabaseError } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

export const handler = async (event) => {
  console.log('Receive Event:', event);
  const id = event.pathParameters?.id;

  if (!id) {
    await logAPIError('Pre-defined id is required');
    return new LambdaResponse(400, new ApiResponse(false, null, 'Pre-defined id is required'));
  }

  try {
    const sql = `SELECT * FROM pre_defined WHERE id = $1`;

    const params = [id];
    const result = await executeQuery(sql, params);

    console.log('Select result:', result);

    if (!result.success) {
      await logDatabaseError(result.error || 'Database error when selecting pre-defined');
      return new LambdaResponse(400, new ApiResponse(false, null, `Error when getting pre-defined data: ${result.error}`));
    }

    if (result.rowCount === 0) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'Pre-defined not found'));
    }

    return new LambdaResponse(200, new ApiResponse(true, result.data));
  } catch (error) {
    console.error('Error:', error);
    await logAPIError('Internal server error');
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error?.message || error));
  }
};