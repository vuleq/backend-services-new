import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { UUID } from 'crypto';

type Permission = {
  id: UUID;
  name: string;
  description: string;
  group_code: number;
  group_name: string;
};

const GROUP_CODE_MAP: Record<number, string> = {
  1: "User Access Management",
  2: "Master Data",
  3: "Project Workspace",
  4: "Works List",
  5: "WDR Editor"
};

export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log("=== Get Permissions API Called ===");

    // Parse query params
    const queryParams = event.queryStringParameters || {};
    const groupCode = queryParams.group_code ? parseInt(queryParams.group_code, 10) : null;

    // Build SQL
    let sql = "SELECT id, name, description, group_code FROM permissions";
    const params: any[] = [];

    if (groupCode) {
      sql += " WHERE group_code = $1";
      params.push(groupCode);
    }

    sql += " ORDER BY group_code, name ASC";

    // Execute query
    const result = await executeQuery(sql, params);

    console.log("Query executed. Row count:", result?.rowCount ?? 0);

    // Check DB errors
    if (!result || result.success === false || result.error) {
      console.error("Database Error:", result?.error || "Unknown error");
      return LambdaResponse.error(
        new ApiResponse(false, null, result?.error || "Database query failed"),
        500
      );
    }

    if (!result.data || result.data.length === 0) {
      if (groupCode) {
        return LambdaResponse.error(
          new ApiResponse(false, null, `Group code ${groupCode} not found`),
          404
        );
      }
      return LambdaResponse.error(
        new ApiResponse(false, null, "No permissions found"),
        404
      );
    }

    // Map permissions: add group_name field
    const permissions: Permission[] = (result.data as any[]).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      group_code: p.group_code,
      group_name: GROUP_CODE_MAP[p.group_code] || "Unknown"
    }));

    // Response chỉ trả về list permissions
    return LambdaResponse.success(
      new ApiResponse(true, permissions, "Permissions retrieved successfully")
    );

  } catch (error: any) {
    console.error("Unhandled Error:", error);
    return LambdaResponse.error(
      new ApiResponse(false, null, error?.message || "An unexpected error occurred while retrieving permissions"),
      500
    );
  }
};
