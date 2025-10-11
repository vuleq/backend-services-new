import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

type Role = {
  id: string;
  name: string;
  description: string;
  code: string;
  is_default: boolean;
  is_delete: boolean;
};

export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log("=== Get All Roles API Called ===");

    const userId = event.queryStringParameters?.userId;
    console.log("userId:", userId);

    const sqlRoles = 'SELECT id, name, description, code, is_default FROM roles ORDER BY created_at DESC';
    const resultRoles = await executeQuery(sqlRoles, []);
    console.log("Roles query result:", resultRoles);

    if (!resultRoles || resultRoles.success === false || resultRoles.error) {
      console.error("Database Error (roles):", resultRoles?.error || "Unknown error");
      return LambdaResponse.error(
        new ApiResponse(false, null, resultRoles?.error || 'Database query failed'),
        500
      );
    }

    if (!resultRoles.data || resultRoles.data.length === 0) {
      console.log("No roles found");
      return LambdaResponse.error(
        new ApiResponse(false, null, 'No roles found'),
        404
      );
    }

    const roles: Role[] = resultRoles.data;

    let rolesWithDeleteFlag: Role[];

    if (!userId) {
      // If userId is null, all is_delete = true
      rolesWithDeleteFlag = roles.map(r => ({
        ...r,
        is_delete: true
      }));
    } else {
      // If there is userId, check active roles
      const sqlActiveRoles = `
        SELECT DISTINCT pa.role_code
        FROM project_assignments pa
        JOIN projects p ON pa.project_id = p.id
        WHERE pa.user_id = $1 AND p.status <> 3 AND pa.role_code IS NOT NULL
      `;

      const resultActiveRoles = await executeQuery(sqlActiveRoles, [userId]);
      console.log("Active roles query result:", resultActiveRoles);

      const activeRoleCodes: string[] = (resultActiveRoles.data || []).map((r: any) => r.role_code);
      console.log("Active role codes:", activeRoleCodes);

      rolesWithDeleteFlag = roles.map(r => ({
        ...r,
        is_delete: !activeRoleCodes.includes(r.code)
      }));
    }

    console.log("Roles with delete flag:", rolesWithDeleteFlag);

    return LambdaResponse.success(
      new ApiResponse(true, rolesWithDeleteFlag, 'Roles retrieved successfully')
    );

  } catch (error: any) {
    console.error('Unhandled Error:', error);
    return LambdaResponse.error(
      new ApiResponse(false, null, 'An unexpected error occurred while retrieving roles'),
      500
    );
  }
};
