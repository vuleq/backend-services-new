import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { isValidUUID } from 'wdr-common-utils';

export const handler = async (event) => {
  console.log('Receive Event:', JSON.stringify(event, null, 2));

  try {
    const projectId = event.queryStringParameters?.['project-id'];

    if (!projectId || !isValidUUID(projectId)) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid project id'));
    }

    const selectResult = await executeQuery(`SELECT DISTINCT u.id, u.name, r.name as role_name, r.code FROM project_trade_section_assigns ptsa
      LEFT JOIN project_trade_sections pts ON pts.id = ptsa.project_trade_section_id
      LEFT JOIN users u ON u.id = ptsa.user_id
      LEFT JOIN roles r ON r.id = ptsa.role_id
      WHERE pts.project_id = $1`, [projectId]);

    if (!selectResult.success) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Error when get assignee list'));
    }

    return new LambdaResponse(200, new ApiResponse(true, selectResult.data));
  } catch (error) {
    console.error('Error:', error);
    return new LambdaResponse(1301, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};