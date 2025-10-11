import { deleteRecord, logAPIError, logDatabaseError } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

export const handler = async (event) => {
  console.log('Receive Event:', event);

  const id = event.pathParameters?.id;

  if (!id) {
    await logAPIError('Pre-defined id is required');
    return new LambdaResponse(400, new ApiResponse(false, null, 'Pre-defined id is required'));
  }

  try {
    const deleteResult = await deleteRecord('pre_defined', { id });
    console.log('Delete Result:', deleteResult);

    if (!deleteResult.success || !deleteResult.rowCount) {
      await logDatabaseError(deleteResult.error ?? 'Failed to delete pre-defined');
      return new LambdaResponse(400, new ApiResponse(false, null, 'Failed to delete pre-defined', deleteResult.error));
    }

    return new LambdaResponse(200, new ApiResponse(true, null, 'Pre-defined deleted successfully'));
  } catch (error) {
    console.error('Error:', error);
    await logAPIError('Internal server error');
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error?.message || error));
  }
};