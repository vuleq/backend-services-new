import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES, buildError } from 'wdr-error-codes';

function isValidUUID(uuid: string) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}
export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Receive Event:', event);
  
  const tradeSectionId = event.pathParameters?.id;
  const roleCode = event.queryStringParameters?.['role-code'];

  if (!tradeSectionId || !isValidUUID(tradeSectionId)) {
    return LambdaResponse.error(new ApiResponse(false, null, 'Invalid trade section id', ERROR_CODES.NOT_FOUND.code));
  }

  try {
    let selectQuery = `SELECT uts.id, u.id as user_id, u.name, u.email, r.name as role FROM user_trade_sections uts JOIN users u ON u.id = uts.user_id JOIN roles r ON uts.role_id = r.id
    WHERE trade_section_id = $1`;
    const selectParams = [tradeSectionId];

    if (roleCode) {
      selectQuery += ' AND r.code = $2';
      selectParams.push(roleCode);
    }

    const selectResult = await executeQuery(selectQuery, selectParams);

    if (!selectResult.success) {
      const err = buildError('DATABASE_ERROR', selectResult.error ?? 'Failed to get assigned user in trade section');
      return new LambdaResponse(500, err);
    }

    const responseData = 'data' in selectResult ? selectResult.data : null;
    return new LambdaResponse(200, new ApiResponse(true, responseData));

  } catch (error: any) {
    console.error('Error:', error);
    const err = buildError('DATABASE_ERROR', error.message);
    return new LambdaResponse(500, err);
  }
};