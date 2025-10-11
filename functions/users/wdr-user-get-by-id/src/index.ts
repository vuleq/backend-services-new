import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES } from 'wdr-error-codes';

type TradeSection = {
  id: string;
  name: string;
};

type Role = {
  id: string;
  code: string;
  name: string;
};

type UserResponse = {
  id: string;
  name: string;
  email: string;
  status: string;
  phone: string;
  signature: string;
  start_date: string;
  trade_sections: TradeSection[];
  roles: Role[];
};

export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log("=== Get User By ID API Called ===");
    console.log("Event: ", event);

    const userId = event.pathParameters?.userId;
    if (!userId) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          "User ID is required",
          ERROR_CODES.INVALID_REQUEST.code
        ),
        400
      );
    }

    const sql = `
      SELECT 
        u.id,
        u.name,
        u.email,
        u.status,
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
      WHERE u.id = $1
      GROUP BY u.id, u.name, u.email, u.status, u.phone_number, u.start_date
      LIMIT 1
    `;

    console.log("query:", sql);

    const result = await executeQuery(sql, [userId]);

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

    if (!result.data || result.data.length === 0) {
      return LambdaResponse.success(
        new ApiResponse(
          false,
          null,
          "User not found",
          ERROR_CODES.RESOURCE_NOT_FOUND.code
        )
      );
    }

    const user: UserResponse = result.data[0];

    return LambdaResponse.success(
      new ApiResponse(true, user, "User retrieved successfully")
    );
  } catch (error: any) {
    console.error("Unhandled Error:", error);
    return LambdaResponse.error(
      new ApiResponse(
        false,
        null,
        "An unexpected error occurred while retrieving user",
        ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code
      ),
      500
    );
  }
};
