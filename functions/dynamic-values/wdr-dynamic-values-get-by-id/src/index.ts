import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES, buildError } from 'wdr-error-codes';

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Receive Event:', event);
  const { id } = event.pathParameters || {};

  if (!id || !isValidUUID(id)) {
    const err = buildError('MISSING_REQUIRED_FIELD', 'Dynamic value id is not valid');
    return new LambdaResponse(400, err);
  }

  try {
    const sql = `SELECT * FROM dynamic_values WHERE id = $1`;

    const params = [id];
    const result = await executeQuery(sql, params);

    console.log('Select result:', result);

    if (!result.success) {
      const err = buildError('DATABASE_ERROR', result.error);
      return new LambdaResponse(500, err);
    }

    if (result.rowCount === 0) {
      const err = buildError('RESOURCE_NOT_FOUND', 'Dynamic value not found');
      return new LambdaResponse(409, err);
    }

    return new LambdaResponse(200, new ApiResponse(true, result.data));
  } catch (error: any) {
    console.error('Error:', error);
    const err = buildError('DATABASE_ERROR', error.message);
    return new LambdaResponse(500, err);
  }
};

function isValidUUID(uuid: string) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}