import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { LambdaResponse, ApiResponse } from 'wdr-models';
import { buildError } from 'wdr-error-codes';

export const handler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
      console.log('=== App Settings Update Lambda Started ===');
      console.log('Event:', JSON.stringify(event, null, 2));

      const appSettingsId = event.pathParameters?.id;

      if (!appSettingsId) {
        return LambdaResponse.error(
          buildError('VALIDATION_ERROR', 'App setting id is required')
        );
      }

      // Parse body
      if (!event.body) {
        return LambdaResponse.error(
          buildError('VALIDATION_ERROR', 'Request body is required')
        );
      }

      let body: any;
      try {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      } catch {
        return LambdaResponse.error(
          buildError('VALIDATION_ERROR', 'Invalid JSON in request body')
        );
      }

      // Validation
      if (!body.group_code || typeof body.group_code !== 'string' || body.group_code.trim().length === 0) {
        return LambdaResponse.error(
          buildError('VALIDATION_ERROR', 'Group code is required and must be a non-empty string')
        );
      }
      if (!body.code || typeof body.code !== 'string' || body.code.trim().length === 0) {
        return LambdaResponse.error(
          buildError('VALIDATION_ERROR', 'Code is required and must be a string')
        );
      }
      if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
        return LambdaResponse.error(
          buildError('VALIDATION_ERROR', 'Name is required and must be a string')
        );
      }
      if (body.value && typeof body.value !== 'string') {
        return LambdaResponse.error(
          buildError('VALIDATION_ERROR', 'Value must be a string if provided')
        );
      }

      // Lấy bản ghi hiện tại
      const existing = await executeQuery(
        `SELECT * FROM app_settings WHERE id = $1`,
        [appSettingsId]
      );

      if (!existing.data || existing.data.length === 0) {
        return LambdaResponse.error(buildError('NOT_FOUND', 'Setting not found'));
      }

      const current = existing.data[0];

      const updated = {
        group_code: body.group_code ?? current.group_code,
        code: body.code ?? current.code,
        name: body.name ?? current.name,
        description: body.description ?? current.description,
        value: body.value ?? current.value
      };

      const query = `
        UPDATE app_settings
        SET group_code = $1,
            code = $2,
            name = $3,
            description = $4,
            value = $5,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $6
        RETURNING *;
      `;

      const params = [
        updated.group_code,
        updated.code,
        updated.name,
        updated.description,
        updated.value,
        appSettingsId
      ];

      const result = await executeQuery(query, params);

      if (!result.data || result.data.length === 0) {
        return LambdaResponse.error(buildError('NOT_FOUND', 'Setting not found'));
      }

      return LambdaResponse.success(
        new ApiResponse(true, result.data[0], 'Setting updated successfully')
      );

    } catch (err) {
      console.error('Error updating setting:', err);
      return LambdaResponse.error(
        buildError('DATABASE_ERROR', 'Error occurred while updating setting')
      );
    }
  };
