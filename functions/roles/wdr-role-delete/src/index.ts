import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery, performTransaction } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { decodeToken } from 'wdr-common-utils';

const defaultUserId = '00000000-0000-0000-0000-000000000000';

export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log("=== Delete Role API Called ===");

    const roleId = event.pathParameters?.id;

    if (!roleId) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Role ID is required"),
        400
      );
    }

    let currentUserId = event.requestContext?.authorizer?.claims?.sub || defaultUserId;
    if (currentUserId === defaultUserId) {
      const rawToken = event.headers?.Authorization || event.headers?.authorization || "";
      const token = rawToken.startsWith("Bearer ") ? rawToken.slice(7) : rawToken;

      if (token) {
        try {
          const decoded: any = decodeToken(token);
          currentUserId = decoded?.payload?.sub || currentUserId;
        } catch (err) {
          console.warn("Failed to decode token:", err);
        }
      }
    }
    console.log(`Current User: (${currentUserId})`);

    const roleCheckSql = `
      SELECT r.code
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = $1
    `;
    const roleCheckResult = await executeQuery(roleCheckSql, [currentUserId]);
    const userRoles = roleCheckResult?.data?.map((r: any) => r.code) || [];

    if (!userRoles.includes("SA")) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Only System Admin (SA) can delete roles"),
        403
      );
    }

    const checkSql = "SELECT id, is_default FROM roles WHERE id = $1";
    const checkResult = await executeQuery(checkSql, [roleId]);

    if (!checkResult?.data || checkResult.data.length === 0) {
      return LambdaResponse.error(
        new ApiResponse(false, null, `Role with id '${roleId}' not found`),
        404
      );
    }

    const role = checkResult.data[0];
    if (role.is_default === true) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Default system roles cannot be deleted"),
        403
      );
    }

    const userCheckSql = "SELECT 1 FROM user_roles WHERE role_id = $1 LIMIT 1";
    const userCheckResult = await executeQuery(userCheckSql, [roleId]);

    if (userCheckResult?.data && userCheckResult.data.length > 0) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Role is currently assigned to one or more users and cannot be deleted"),
        409
      );
    }

    const txResult = await performTransaction([
      {
        type: "delete",
        table: "role_permissions",
        condition: { role_id: roleId }
      },
      {
        type: "delete",
        table: "roles",
        condition: { id: roleId }
      }
    ]);

    if (!txResult.success) {
      console.error("Transaction Error:", txResult.error);
      return LambdaResponse.error(
        new ApiResponse(false, null, txResult.error || "Failed to delete role"),
        500
      );
    }

    return LambdaResponse.success(
      new ApiResponse(true, null, "Role deleted successfully")
    );

  } catch (error: any) {
    console.error("Unhandled Error:", error);
    return LambdaResponse.error(
      new ApiResponse(false, null, error?.message || "An unexpected error occurred while deleting role"),
      500
    );
  }
};
