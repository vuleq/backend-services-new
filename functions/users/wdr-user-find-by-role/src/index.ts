import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES } from 'wdr-error-codes';
import { UUID } from 'crypto';

type User = {
    id: UUID;
    name: string;
    avt: string;
    email: string;
    role_name: string;
    role_code: string;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const queryParams = event.queryStringParameters || {};
    const pathParams = event.pathParameters || {};
    
    // Extract role code from path parameters or query string parameters
    const roleCode = pathParams.role || queryParams.role;
    
    // Query users by role code
    let sql = `
      SELECT u.id, u.name, u.avt, u.email, r.name as role_name, r.code as role_code
      FROM users u
      JOIN user_roles ur ON u.id = ur.user_id
      JOIN roles r ON ur.role_id = r.id
    `;

    const params: any[] = [];

    if (roleCode) {
      sql += ` WHERE r.code = $1`;
      params.push(roleCode);
    }

    const result = await executeQuery(sql, params);

    if (!result || result.rowCount === 0) {
      return LambdaResponse.success(new ApiResponse(false, null, 'No users found with the specified role code', ERROR_CODES.RESOURCE_NOT_FOUND.code));
    }

    const users: User[] = result.data;
    return LambdaResponse.success(new ApiResponse(true, users, `Found ${users.length} users with role code: ${roleCode}`, ERROR_CODES.SUCCESS.code));
  } catch (error) {
    console.error('Error in wdr-user-find-by-role:', error);
    return LambdaResponse.success(new ApiResponse(false, null, 'An error occurred while retrieving users', ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code));
  }
};