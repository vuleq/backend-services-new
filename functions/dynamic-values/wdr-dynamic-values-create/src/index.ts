import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery, insertRecord } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES, buildError } from 'wdr-error-codes';

interface DynamicValueData {
  name?: string;
  description?: string;
  created_by?: string;
  updated_by?: string;
  created_at?: string;
  updated_at?: string
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Receive Event:', event);

  const body = event.body ? JSON.parse(event.body) : {};
  const userId = event.requestContext?.authorizer?.claims?.sub || '00000000-0000-0000-0000-000000000000'

  const dynamicValueData: DynamicValueData = {
    name: body.name,
    description: body.description,
    created_by: userId,
    updated_by: userId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }

  if (!dynamicValueData.name || dynamicValueData.name.trim() === '') {
    const err = buildError('MISSING_REQUIRED_FIELD', 'Dynamic value name is required');
    return new LambdaResponse(400, new ApiResponse(false, null, err.message, err.errorCode));
  }

  if (!dynamicValueData.description || dynamicValueData.description.trim() === '') {
    const err = buildError('MISSING_REQUIRED_FIELD', 'Dynamic value description is required');
    return new LambdaResponse(400, new ApiResponse(false, null, err.message, err.errorCode));
  }

  try {
    const selectQuery = 'SELECT id FROM dynamic_values WHERE name = $1';
    const selectResult = await executeQuery(selectQuery, [dynamicValueData.name]);

    if (!selectResult.success) {
      const err = buildError('DATABASE_ERROR', selectResult.error ?? 'Failed to check existing Dynamic value');
      return new LambdaResponse(500, new ApiResponse(false, null, err.message, err.errorCode));
    }

    if (selectResult.data.length > 0) {
      const err = buildError('RESOURCE_ALREADY_EXISTS', 'Dynamic value name already exists');
      return new LambdaResponse(409, new ApiResponse(false, null, err.message, err.errorCode));
    }

    const insertResult = await insertRecord('dynamic_values', dynamicValueData)

    if (!insertResult.success) {
      const errorMsg = 'error' in insertResult && insertResult.error ? insertResult.error : 'Failed to create dynamic value';
      const err = buildError('DATABASE_ERROR', errorMsg);
      return new LambdaResponse(500, new ApiResponse(false, null, err.message, err.errorCode));
    }

    const responseData = 'data' in insertResult ? insertResult.data : null;
    return new LambdaResponse(200, new ApiResponse(true, responseData, 'Dynamic value created successfully'));

  } catch (error: any) {
    console.error('Error:', error);
    const err = buildError('DATABASE_ERROR', error.message);
    return new LambdaResponse(500, new ApiResponse(false, null, err.message, err.errorCode));
  }
};