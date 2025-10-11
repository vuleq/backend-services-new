import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES } from 'wdr-error-codes';
import { UUID } from 'crypto';

type Role = {
    id: UUID;
    name: string;
    description: string;
    code: string;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const queryParams = event.queryStringParameters || {};
    
    // Search params
    const roleId = queryParams.id || null;
    const roleName = queryParams.name || null;
    const roleCode = queryParams.code || null;

    // Build dynamic SQL query with WHERE conditions
    let sql = 'SELECT id, name, description, code FROM roles';
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (roleId) {
      conditions.push(`id = $${paramIndex}`);
      params.push(roleId);
      paramIndex++;
    }

    if (roleCode) {
      conditions.push(`code = $${paramIndex}`);
      params.push(roleCode);
      paramIndex++;
    }

    if (roleName) {
      conditions.push(`name ILIKE $${paramIndex}`);
      params.push(`%${roleName}%`);
      paramIndex++;
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const result = await executeQuery(sql, params);

    if (!result || result.rowCount === 0) {
      return LambdaResponse.error(new ApiResponse(false, null, 'Role not found', ERROR_CODES.NOT_FOUND.code));
    }

    const roles: Role[] = result.data;
    return LambdaResponse.success(new ApiResponse(true, roles, 'Roles retrieved successfully', 200));
  } catch (error) {
    console.error('Error:', error);
    return LambdaResponse.error(new ApiResponse(false, null, 'An error occurred while retrieving the role', ERROR_CODES.INTERNAL_SERVER_ERROR.code));
  }
};
