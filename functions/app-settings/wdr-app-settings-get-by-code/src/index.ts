import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { LambdaResponse, ApiResponse } from 'wdr-models';
import { buildError } from 'wdr-error-codes';

export const handler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event): Promise<APIGatewayProxyResult> => {
    try {
      console.log('=== App Settings Get By Code Lambda Started ===');
      console.log('Event:', JSON.stringify(event, null, 2));

      const code: string | null = event?.queryStringParameters?.code || null;

      if (!code) {
        return LambdaResponse.error(
          buildError('VALIDATION_ERROR', 'Parameter code is required')
        );
      }

      const query = `
        SELECT id, group_code, code, name, description, value, unit
        FROM app_settings
        WHERE code = $1
        LIMIT 1
      `;
      const params: [string] = [code];

      const result = await executeQuery(query, params);

      if (!result.data || result.data.length === 0) {
        return LambdaResponse.error(
          buildError('NOT_FOUND', `Setting with code ${code} not found`)
        );
      }

      return LambdaResponse.success(
        new ApiResponse(true, result.data[0], 'Setting retrieved successfully')
      );

    } catch (err) {
      console.error('Error fetching setting by code:', err);
      return LambdaResponse.error(
        buildError('DATABASE_ERROR', 'Error occurred while fetching setting by code')
      );
    }
  };
