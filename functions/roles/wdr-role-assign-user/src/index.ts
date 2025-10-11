import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { executeQuery, performTransaction, Operation } from "wdr-connect-db";
import { ApiResponse, LambdaResponse } from "wdr-models";
import { decodeToken } from "wdr-common-utils";

const defaultUserId = "00000000-0000-0000-0000-000000000000";

interface AddUsersToRoleRequest {
  userIds: string[];
}

const roleEnum: Record<string, number> = {
  "Super User": 0,
  "SRM": 1,
  "Safety Officer": 2,
  "Commercial Officer Admin": 3,
  "Commercial Officer": 4,
  "Guest": 5,
  "HOD": 6,
};

const projectStatus = {
  NotStarted: 0,
  Started: 1,
  Completed: 2,
  Closed: 3
};

export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log("=== Add Users to Role API Called ===");
    console.log("Receive Event:", event);

    const roleId = event.pathParameters?.id;
    if (!roleId) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Role ID is required"),
        400
      );
    }

    // current user
    let currentUserId =
      event.requestContext?.authorizer?.claims?.sub || defaultUserId;
    if (currentUserId === defaultUserId) {
      const rawToken =
        event.headers?.Authorization || event.headers?.authorization || "";
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

    // parse body
    const body: AddUsersToRoleRequest = JSON.parse(event.body || "{}");
    const userIds: string[] = body.userIds || [];

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "userIds must be a non-empty array"),
        400
      );
    }

    // check role tồn tại
    const roleResult = await executeQuery(
      "SELECT id, name, code FROM roles WHERE id = $1",
      [roleId]
    );
    if (!roleResult?.data || roleResult.data.length === 0) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Role not found"),
        404
      );
    }
    const role = roleResult.data[0];
    const isSuperUser = role.code === "SU";
    const isCOA = role.code === "COA";
    const isHOD = role.code === "HOD";

    const operations: Operation[] = [];

    // === Add users vào role ===
    for (const uid of userIds) {
      // add vào user_roles
      operations.push({
        type: "insert",
        table: "user_roles",
        data: {
          user_id: uid,
          role_id: roleId,
          created_by: currentUserId,
          updated_by: currentUserId,
        },
      });

      // gán permissions
      operations.push({
        type: "query",
        queryText: `
          INSERT INTO user_permissions (user_id, role_id, permission_id)
          SELECT $1, $2, rp.permission_id
          FROM role_permissions rp
          WHERE rp.role_id = $2
          ON CONFLICT DO NOTHING
        `,
        params: [uid, roleId],
      });

      // Super User & COA -> join all projects (trừ Closed)
      if (isSuperUser || isCOA) {
        operations.push({
          type: "query",
          queryText: `
            INSERT INTO project_assignments (project_id, user_id, role, role_code)
            SELECT p.id, $1, $2, $3
            FROM projects p
            WHERE p.status <> $4
            ON CONFLICT DO NOTHING
          `,
          params: [uid, roleEnum[role.name], role.code, projectStatus.Closed],
        });
      }

      // // HOD -> join all projects (trừ Closed) + trade_id
      // if (isHOD) {
      //   operations.push({
      //     type: "query",
      //     queryText: `
      //       INSERT INTO project_assignments (project_id, user_id, role, role_code, trade_id)
      //       SELECT p.id, $1, $2, $3, $4
      //       FROM projects p
      //       WHERE p.status <> $5
      //       ON CONFLICT DO NOTHING
      //     `,
      //     params: [
      //       uid,
      //       roleEnum[role.name],
      //       role.code,
      //       role.trade_id,
      //       projectStatus.Closed,
      //     ],
      //   });
      // }
    }

    const txResult = await performTransaction(operations);

    if (!txResult.success) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          txResult.error || "Failed to add users to role"
        ),
        500
      );
    }

    return LambdaResponse.success(
      new ApiResponse(true, null, "Users added to role successfully")
    );
  } catch (error: any) {
    console.error("Unhandled Error:", error);
    return LambdaResponse.error(
      new ApiResponse(false, null, error?.message || "Unexpected error"),
      500
    );
  }
};
