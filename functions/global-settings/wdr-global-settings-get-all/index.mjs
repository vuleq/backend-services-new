import { executeQuery } from 'wdr-connect-db';
import { ApiResponse } from 'wdr-models';

export const handler = async (event) => {
  try {
    let selectSql = 'SELECT * FROM global_settings;';
    let selectParams = [];
    
    const result = await executeQuery(selectSql, selectParams);

    if (result.error) {
      return new ApiResponse(false, null, 'Failed to get global_settings', result.error);
    }

    return new ApiResponse(true, result.data);
  } catch (error) {
    console.error('Error:', error);
    return new ApiResponse(false, null, 'Internal server error', error.message);
  }
};