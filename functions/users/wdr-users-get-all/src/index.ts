import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { executeQuery } from "wdr-connect-db";
import { ApiResponse, LambdaResponse, ResponsePage } from "wdr-models";
import { ERROR_CODES } from "wdr-error-codes";

type TradeSection = { id: string; name: string };
type Role = { id: string; code: string; name: string };

type UserResponse = {
  id: string;
  name: string;
  email: string;
  status: string;
  phone: string;
  user_type: string;
  start_date: string;
  trade_sections: TradeSection[];
  roles: Role[];
};

const sortFieldMap: Record<string, string> = {
  name: "u.name",
  email: "u.email",
  status: "u.status",
  role: "MIN(r.name)",
  trade_section: "MIN(ts.name)",
  created_at: "u.created_at",
};

export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log("=== Get Users API Called ===");
    console.log("Event:", event);

    const queryParams = event.queryStringParameters ?? {};
    const multiParams = (event as any).multiValueQueryStringParameters ?? {};

    // Pagination & Sort
    const pageNumber = parseInt(queryParams.pageNumber ?? "1", 10);
    const pageSize = parseInt(queryParams.pageSize ?? "10", 10);
    const offset = (pageNumber - 1) * pageSize;
    const sortField = queryParams.sortField ?? "created_at";
    const sortOrder =
      (queryParams.sortOrder ?? "desc").toUpperCase() === "ASC" ? "ASC" : "DESC";

    // Filters
    const search = queryParams.search ?? null;
    const tradeSections: string[] = multiParams.tradeSection ?? [];
    const roles: string[] = multiParams.role ?? [];
    const statuses: string[] = multiParams.status ?? [];

    console.log("Filters:", { statuses, search, tradeSections, roles });

    // Build dynamic WHERE
    const whereClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (statuses.length > 0) {
      whereClauses.push(`u.status = ANY($${paramIndex++}::int[])`);
      params.push(statuses.map(Number));
    }

    if (search) {
      whereClauses.push(
        `(LOWER(u.name) LIKE LOWER($${paramIndex}) OR LOWER(u.email) LIKE LOWER($${paramIndex}))`
      );
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (tradeSections.length > 0) {
      whereClauses.push(`EXISTS (
        SELECT 1 FROM user_trade_sections uts2
        WHERE uts2.user_id = u.id
          AND uts2.trade_section_id = ANY($${paramIndex++}::uuid[])
      )`);
      params.push(tradeSections);
    }

    if (roles.length > 0) {
      whereClauses.push(`EXISTS (
        SELECT 1 FROM user_roles ur2
        WHERE ur2.user_id = u.id
          AND ur2.role_id = ANY($${paramIndex++}::uuid[])
      )`);
      params.push(roles);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    // Query total count
    const sqlCount = `
      SELECT COUNT(DISTINCT u.id) AS total
      FROM users u
      LEFT JOIN user_trade_sections uts ON u.id = uts.user_id
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      ${whereSql}
    `;
    console.log("SQL Count:", sqlCount);

    const resultCount = await executeQuery(sqlCount, params);
    if (!resultCount || resultCount.success === false || resultCount.error) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          resultCount?.error || "Count query failed",
          ERROR_CODES.DATABASE_ERROR.code
        ),
        500
      );
    }

    const totalCount = parseInt(resultCount.data[0].total, 10);
    const orderBy = sortFieldMap[sortField] ?? "u.created_at";

    // Query users with paging
    const sql = `
      SELECT 
        u.id,
        u.name,
        u.email,
        u.status,
        u.user_type,
        u.phone_number AS phone,
        u.start_date,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', ts.id, 'name', ts.name))
          FILTER (WHERE ts.id IS NOT NULL), '[]'
        ) AS trade_sections,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name))
          FILTER (WHERE r.id IS NOT NULL), '[]'
        ) AS roles
      FROM users u
      LEFT JOIN user_trade_sections uts ON u.id = uts.user_id
      LEFT JOIN trade_sections ts ON uts.trade_section_id = ts.id
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id OR uts.role_id = r.id
      ${whereSql}
      GROUP BY u.id, u.name, u.email, u.status, u.phone_number, u.start_date
      ORDER BY ${orderBy} ${sortOrder}, u.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    console.log("SQL Query:", sql);

    const result = await executeQuery(sql, [...params, pageSize, offset]);
    if (!result || result.success === false || result.error) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          result?.error || "Database query failed",
          ERROR_CODES.DATABASE_ERROR.code
        ),
        500
      );
    }

    const users: UserResponse[] = result.data;
    const responsePage = new ResponsePage<UserResponse>(
      pageNumber,
      pageSize,
      totalCount,
      users
    );

    return LambdaResponse.success(
      new ApiResponse(true, responsePage, "Users retrieved successfully", ERROR_CODES.SUCCESS.code)
    );
  } catch (error: any) {
    console.error("Unhandled Error:", error);
    return LambdaResponse.error(
      new ApiResponse(
        false,
        null,
        "An unexpected error occurred while retrieving users",
        ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code
      ),
      500
    );
  }
};
