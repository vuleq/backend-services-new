import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

const GROUP_CODE_MAP: Record<number, string> = {
  1: "Project Workspace",
  2: "Works List",
  3: "WDR Editor",
  4: "Master Data",
  5: "User Access Management"
};

type Permission = {
  id: string;
  name: string;
  group_code: string;
  description: string;
  group_name?: string;
};

type User = {
  id: string;
  name: string;
  email: string;
};

export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const roleId = event.pathParameters?.id;
    console.log("=== Get Role Detail API Called ===", { roleId });

    if (!roleId) {
      return LambdaResponse.error(
        new ApiResponse(false, null, 'Missing roleId in path'),
        400
      );
    }

    // Step 1. Get role information
    const roleSql = 'SELECT id, name, description, code FROM roles WHERE id = $1';
    const roleResult = await executeQuery(roleSql, [roleId]);

    if (!roleResult || roleResult.success === false || roleResult.error) {
      console.error("Database Error (Role):", roleResult?.error || "Unknown error");
      return LambdaResponse.error(
        new ApiResponse(false, null, roleResult?.error || 'Database query failed')
      );
    }

    if (!roleResult.data || roleResult.data.length === 0) {
      return LambdaResponse.error(
        new ApiResponse(false, null, 'Role not found'),
        404
      );
    }

    const role = roleResult.data[0];

    // Step 2. Get list permissions
    const permSql = `
      SELECT p.id, p.name, p.description, p.group_code
      FROM permissions p
      INNER JOIN role_permissions rp ON rp.permission_id = p.id
      WHERE rp.role_id = $1
      ORDER BY p.name ASC
    `;
    const permResult = await executeQuery(permSql, [roleId]);
    let permissions: Permission[] =
      permResult && permResult.success !== false && !permResult.error && permResult.data
        ? permResult.data
        : [];

    // Add group_name for each permission
    permissions = permissions.map((p) => ({
      ...p,
      group_name: GROUP_CODE_MAP[Number(p.group_code)] || "Unknown"
    }));

    // Step 3. Get list users
    const userSql = `
      SELECT u.id, u.name, u.email
      FROM users u
      INNER JOIN user_roles ur ON ur.user_id = u.id
      WHERE ur.role_id = $1
    `;
    const userResult = await executeQuery(userSql, [roleId]);
    const users: User[] =
      userResult && userResult.success !== false && !userResult.error && userResult.data
        ? userResult.data
        : [];

    const responseData = {
      ...role,
      permissions,
      users
    };

    return LambdaResponse.success(
      new ApiResponse(true, responseData, 'Role detail retrieved successfully')
    );

  } catch (error) {
    console.error('Unhandled Error:', error);
    return LambdaResponse.error(
      new ApiResponse(false, null, 'An unexpected error occurred while retrieving role detail'),
      500
    );
  }
};
