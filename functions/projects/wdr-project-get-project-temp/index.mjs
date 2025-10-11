import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

export const handler = async (event) => {
  try {
      const projectTempResult = await executeQuery('SELECT * FROM project_temp LIMIT 1', []);
      if (!projectTempResult.success) {
          return new LambdaResponse(400, new ApiResponse(false, null, 'Database error', error.message));
      }

      if (projectTempResult.data && projectTempResult.data.length > 0) {
        return new LambdaResponse(200, new ApiResponse(true, projectTempResult.data[0]));
      } else {
          return new LambdaResponse(400, new ApiResponse(false, null, 'No project temp found'));
      }
  } catch (error) {
      console.error('Error:', error);
      return new LambdaResponse(400, new ApiResponse(false, null, 'Internal server error', error.message));
  }
}