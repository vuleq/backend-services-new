import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { decodeToken } from 'wdr-common-utils';
import { ERROR_CODES } from 'wdr-error-codes';

const defaultUserId = '00000000-0000-0000-0000-000000000000';

export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log("=== Get User Info, Roles, Permissions & Trade Sections API Called ===");

    // --- Step 1: Resolve currentUserId ---
    let currentUserId = event.requestContext?.authorizer?.claims?.sub || defaultUserId;

    if (currentUserId === defaultUserId) {
      const rawToken = event.headers?.Authorization || event.headers?.authorization || "";
      const token = rawToken.startsWith("Bearer ") ? rawToken.slice(7) : rawToken;
      if (token) {
        try {
          const decoded: any = decodeToken(token);
          currentUserId = decoded?.sub || decoded?.payload?.sub || currentUserId;
        } catch (err) {
          console.warn("Failed to decode token:", err);
        }
      }
    }

    console.log("Resolved currentUserId:", currentUserId);

    if (!currentUserId || currentUserId === defaultUserId) {
      return LambdaResponse.error(
        new ApiResponse(false, null, 'Unauthorized: Cannot resolve userId', ERROR_CODES.INVALID_REQUEST.code),
        401
      );
    }

    // --- Step 2: Query user + roles + permissions + trade_sections ---
    const sql = `
      SELECT 
        u.id, u.name, u.email, u.phone_number AS phone, 
        u.status, u.signature, u.start_date,

        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name, 'code', r.code))
          FILTER (WHERE r.id IS NOT NULL), '[]'
        ) AS roles,

        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', p.id, 'name', p.name))
          FILTER (WHERE p.id IS NOT NULL), '[]'
        ) AS permissions,

        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', ts.id, 'name', ts.name))
          FILTER (WHERE ts.id IS NOT NULL), '[]'
        ) AS trade_sections

      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON ur.role_id = r.id
      LEFT JOIN user_permissions up ON up.user_id = u.id
      LEFT JOIN permissions p ON up.permission_id = p.id
      LEFT JOIN user_trade_sections uts ON uts.user_id = u.id
      LEFT JOIN trade_sections ts ON uts.trade_section_id = ts.id

      WHERE u.id = $1
      GROUP BY u.id
      LIMIT 1
    `;

    const result = await executeQuery(sql, [currentUserId]);

    if (!result?.success || result.error) {
      console.error("Database Error:", { userId: currentUserId, error: result?.error });
      return LambdaResponse.error(
        new ApiResponse(false, null, result?.error || 'Database query failed', ERROR_CODES.DATABASE_ERROR.code),
        500
      );
    }

    if (!result.data?.length) {
      return LambdaResponse.error(
        new ApiResponse(false, null, 'User not found', ERROR_CODES.RESOURCE_NOT_FOUND.code),
        404
      );
    }

    const user = result.data[0];

    // --- Step 3: Response ---
    return LambdaResponse.success(
      new ApiResponse(true, user, 'User info, roles, permissions & trade sections retrieved successfully')
    );

  } catch (error: any) {
    console.error('Unhandled Error:', error);
    return LambdaResponse.error(
      new ApiResponse(false, null, 'An unexpected error occurred while retrieving user info, roles & permissions', ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code),
      500
    );
  }
};
