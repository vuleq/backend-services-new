import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { LambdaResponse, ApiResponse } from 'wdr-models';
import { buildError } from 'wdr-error-codes';

export const handler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
      console.log('=== App Settings Delete Lambda Started ===');
      console.log('Event:', JSON.stringify(event, null, 2));

      const appSettingsId = event.pathParameters?.id;

      if (!appSettingsId) {
        return LambdaResponse.error(
          buildError('VALIDATION_ERROR', 'App setting id is required')
        );
      }

      const query = `
        DELETE FROM app_settings
        WHERE id = $1
        RETURNING *;
      `;
      const params = [appSettingsId];

      const result = await executeQuery(query, params);

      if (!result.data || result.data.length === 0) {
        return LambdaResponse.error(
          buildError('NOT_FOUND', 'Setting not found')
        );
      }

      return LambdaResponse.success(
        new ApiResponse(true, result.data[0], 'Setting deleted successfully')
      );

    } catch (err) {
      console.error('Error deleting setting:', err);
      return LambdaResponse.error(
        buildError('DATABASE_ERROR', 'Error occurred while deleting setting')
      );
    }
  };
