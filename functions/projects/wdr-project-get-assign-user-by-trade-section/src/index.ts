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
  
  const projectId = event.pathParameters?.id;

  if (!projectId || !isValidUUID(projectId)) {
    return LambdaResponse.error(new ApiResponse(false, null, 'Invalid project id', ERROR_CODES.NOT_FOUND.code));
  }

  const tradeSectionId = event.queryStringParameters?.['trade-section-id'];

  if (!tradeSectionId || !isValidUUID(tradeSectionId)) {
    return LambdaResponse.error(new ApiResponse(false, null, 'Invalid trade section id', ERROR_CODES.NOT_FOUND.code));
  }

  try {
    const selectQuery = `SELECT u.id, u.name, ro.name as role
    FROM project_trade_sections pts
    LEFT JOIN project_trade_section_assigns ptsa ON ptsa.project_trade_section_id = pts.id
    LEFT JOIN users u ON u.id = ptsa.user_id
    LEFT JOIN roles ro ON ro.id = ptsa.role_id
    WHERE pts.project_id = $1 AND pts.trade_section_id = $2`;
    const selectResult = await executeQuery(selectQuery, [projectId, tradeSectionId]);

    if (!selectResult.success) {
      const err = buildError('DATABASE_ERROR', selectResult.error ?? 'Failed to check existing Dynamic value');
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