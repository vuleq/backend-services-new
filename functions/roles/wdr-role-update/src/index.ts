import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { executeQuery, performTransaction, Operation } from "wdr-connect-db";
import { ApiResponse, LambdaResponse } from "wdr-models";
import { decodeToken } from "wdr-common-utils";

interface UpdateRoleRequest {
  name?: string;
  description?: string | null;
  permissionIds?: string[];
}

const defaultUserId = '00000000-0000-0000-0000-000000000000';

export const handler: Handler = async (
  event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log("=== Update Role Permissions API Called ===");
    console.log('Receive Event:', event);

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

    const body: UpdateRoleRequest = JSON.parse(event.body || "{}");

    const { name, description, permissionIds } = body;
    console.log(body)

    let newPermissions: string[] | undefined = undefined;
    if (permissionIds !== undefined) {
      if (!Array.isArray(permissionIds)) {
        return LambdaResponse.error(
          new ApiResponse(false, null, "permissionIds must be an array"),
          400
        );
      }
      newPermissions = permissionIds;
    }

    // === Check role exists & get old data ===
    const roleResult = await executeQuery(
      "SELECT id, name, description, is_default FROM roles WHERE id = $1",
      [roleId]
    );
    if (!roleResult?.data || roleResult.data.length === 0) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Role not found"),
        404
      );
    }

    const oldRole = roleResult.data[0];

    // Merge name, description
    const finalName = name || oldRole.name;
    const finalDescription =
      description !== undefined ? description : oldRole.description;

    // === Check role name unique ===
    const nameCheck = await executeQuery(
      "SELECT id FROM roles WHERE name = $1 AND id <> $2",
      [finalName, roleId]
    );
    if (nameCheck?.data?.length > 0) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Role name already exists"),
        409
      );
    }

    let newCode: string | undefined = undefined;
    if (!oldRole.is_default) {
      newCode = await generateUniqueRoleCode(finalName, roleId);
    }


    const operations: Operation[] = [];

    // === Update role info ===
    const updateData: any = {
      name: finalName,
      description: finalDescription,
      updated_by: currentUserId,
    };

    if (newCode) {
      updateData.code = newCode;
    }

    operations.push({
      type: "update",
      table: "roles",
      data: updateData,
      condition: { id: roleId },
    });

    if (newPermissions !== undefined) {
      const oldResult = await executeQuery(
        "SELECT permission_id FROM role_permissions WHERE role_id = $1",
        [roleId]
      );
      const oldPermissions: string[] =
        oldResult?.data?.map((r: any) => r.permission_id) || [];

      // Diff
      const toRemove = oldPermissions.filter((p) => !newPermissions!.includes(p));
      const toAdd = newPermissions.filter((p) => !oldPermissions.includes(p));

      console.log("Old:", oldPermissions, "New:", newPermissions);
      console.log("ToRemove:", toRemove, "ToAdd:", toAdd);

      // === Delete permission has been removed ===
      for (const pid of toRemove) {
        operations.push({
          type: "delete",
          table: "role_permissions",
          condition: { role_id: roleId, permission_id: pid },
        });

        operations.push({
          type: "delete",
          table: "user_permissions",
          condition: { role_id: roleId, permission_id: pid },
        });
      }

      // === Add new permission ===
      for (const pid of toAdd) {
        operations.push({
          type: "insert",
          table: "role_permissions",
          data: { role_id: roleId, permission_id: pid },
        });

        // Copy user_permissions (only user of role)
        operations.push({
          type: "query",
          queryText: `
            INSERT INTO user_permissions (user_id, role_id, permission_id)
            SELECT ur.user_id, ur.role_id, $1
            FROM user_roles ur
            WHERE ur.role_id = $2
            ON CONFLICT DO NOTHING
          `,
          params: [pid, roleId],
        });
      }
    }

    const txResult = await performTransaction(operations);

    if (!txResult.success) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          txResult.error || "Failed to update role permissions"
        ),
        500
      );
    }

    return LambdaResponse.success(
      new ApiResponse(true, null, "Role updated successfully")
    );
  } catch (error: any) {
    console.error("Unhandled Error:", error);
    return LambdaResponse.error(
      new ApiResponse(
        false,
        null,
        error?.message || "Unexpected error while updating role permissions"
      ),
      500
    );
  }
};

async function generateUniqueRoleCode(name: string, roleId?: string): Promise<string> {
  const baseCode = generateRoleCode(name);
  let finalCode = baseCode;
  let counter = 1;

  while (true) {
    const result = await executeQuery(
      "SELECT id FROM roles WHERE code = $1 AND id <> $2",
      [finalCode, roleId || ""]
    );

    if (!result?.data || result.data.length === 0) {
      return finalCode;
    }

    finalCode = `${baseCode}${counter}`;
    counter++;
  }
}

function generateRoleCode(name: string): string {
  const words = name.trim().split(/\s+/);

  if (words.length === 1) {
    return words[0].substring(0, 3).toUpperCase();
  }

  return words.map(w => w[0].toUpperCase()).join("");
}
