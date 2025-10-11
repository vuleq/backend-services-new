import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { LambdaResponse, ApiResponse, createApiResponse } from 'wdr-models';
import { ERROR_CODES , buildError} from 'wdr-error-codes';
import { UUID } from 'crypto';

// Enum for global settings type
export enum GlobalSettingsType {
  MASTER_DATA = 'master_data',
  APP_SETTINGS = 'app_settings'
}

type GlobalSettings = {
  id: UUID;
  group: GlobalSettingsType;
  file_size: number;
  max_compress: number;
  is_auto_save: boolean;
  font_size: number;
  auto_save_time: number;
}

// Lambda function Handler for getting global settings by group
export const handler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> = async (event) => {
  // Try to get 'group' from pathParameters, queryStringParameters, or request body
  let group = event.pathParameters?.group 
    || event.queryStringParameters?.group;

  if (!group && event.body) {
    try {
      const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      group = body.group;
    } catch {
      // Ignore JSON parse errors, will handle missing group below
    }
  }

  if (!group) {
    const response = buildError(ERROR_CODES.INVALID_REQUEST.errorCode, 'Group is required');
    return LambdaResponse.error(response);
  }

  try {
    if (!Object.values(GlobalSettingsType).includes(group as GlobalSettingsType)) {
      const response = buildError(ERROR_CODES.INVALID_REQUEST.errorCode, 'Invalid group');
      return LambdaResponse.error(response);
    }
    const settings = await getGlobalSettingsByGroup(group as GlobalSettingsType);
    const response = createApiResponse<GlobalSettings[]>(true, ERROR_CODES.SUCCESS, settings);
    return LambdaResponse.success(response);
  } catch (error) {
    const response = buildError(ERROR_CODES.DATABASE_ERROR.errorCode, 'Failed to retrieve global settings');
    console.error('Error retrieving global settings:', error);
    return LambdaResponse.error(response);
  }
};

const getGlobalSettingsByGroup = async (group: GlobalSettingsType): Promise<GlobalSettings[]> => {
  const query = `
    SELECT * FROM global_settings
    WHERE setting_group = $1
  `;
  const result = await executeQuery(query, [group]);
  return result.data;
};
