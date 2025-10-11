import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { decodeToken } from 'wdr-common-utils';

const defaultUserId = '00000000-0000-0000-0000-000000000000';

type Role = {
  id: string;
  role: string;
  role_code: string;
};

type Permission = {
  id: string;
  name: string;
};


export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log("=== Get User Roles & Permissions API Called ===");
    console.log("Event:", event);
    const projectId = event.queryStringParameters?.project_id;

    if (!projectId) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Project id is required'));
    }

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
        new ApiResponse(false, null, 'Unauthorized: Cannot resolve userId'), 401);
    }

    // --- Step 2: Get all roles of user in project ---
    const sqlRoles = `
        SELECT pa.id::text AS id, pa.role, pa.role_code
        FROM project_assignments pa
        WHERE pa.project_id = $1 AND pa.user_id = $2

        UNION

        SELECT ptsa.id::text AS id, 1, r.code AS role_code
        FROM project_trade_section_assigns ptsa
        JOIN project_trade_sections pts ON ptsa.project_trade_section_id = pts.id
        JOIN roles r ON ptsa.role_id = r.id
        WHERE pts.project_id = $1 AND ptsa.user_id = $2
      `;

    const resultRoles = await executeQuery(sqlRoles, [projectId, currentUserId]);
    let roles: Role[] = resultRoles?.data || [];

    if (!roles.length) {
      return LambdaResponse.error(
        new ApiResponse(false, null, 'User has no roles in this project'), 403
      );
    }

    // --- Step 3: Deduplicate roles by role_code ---
    const uniqueRoles: Role[] = [];
    const seenCodes = new Set<string>();
    for (const r of roles) {
      if (!seenCodes.has(r.role_code)) {
        uniqueRoles.push(r);
        seenCodes.add(r.role_code);
      }
    }

    // --- Step 4: Get trades ---
    let trades: any[] = [];

    const restrictedRoles = ['HOD', 'FOR', 'TS'];
    const hasRestricted = uniqueRoles.some(r => restrictedRoles.includes(r.role_code));
    const hasNonRestricted = uniqueRoles.some(r => !restrictedRoles.includes(r.role_code));

    if (hasRestricted && !hasNonRestricted) {
      // Case 1: only HOD/FOR/TS
      const sqlTrades = `
        SELECT DISTINCT ts.id, ts.name
        FROM project_trade_section_assigns ptsa
        JOIN project_trade_sections pts ON ptsa.project_trade_section_id = pts.id
        JOIN trade_sections ts ON pts.trade_section_id = ts.id
        WHERE pts.project_id = $1 AND ptsa.user_id = $2
      `;
      const resultTrades = await executeQuery(sqlTrades, [projectId, currentUserId]);
      trades = resultTrades?.data || [];
    } else {
      // Case 2: has roles other than restricted → full access
      const sqlTrades = `
        SELECT DISTINCT ts.id, ts.name
        FROM project_trade_sections pts
        JOIN trade_sections ts ON pts.trade_section_id = ts.id
        WHERE pts.project_id = $1
      `;
      const resultTrades = await executeQuery(sqlTrades, [projectId]);
      trades = resultTrades?.data || [];
    }


    // --- Step 5: Permissions ---
    const sqlPermissions = `
        SELECT DISTINCT p.id, p.name
        FROM user_permissions up
        JOIN permissions p ON up.permission_id = p.id
        WHERE up.user_id = $1
      `;
    const resultPermissions = await executeQuery(sqlPermissions, [currentUserId]);
    const permissions: Permission[] = resultPermissions?.data || [];

    // --- Step 6: Return ---
    return LambdaResponse.success(
      new ApiResponse(true, { roles: uniqueRoles, trades, permissions }, 'User roles, trades & permissions retrieved successfully')
    );
  } catch (error: any) {
    console.error('Unhandled Error:', error);
    return LambdaResponse.error(
      new ApiResponse(false, null, 'An unexpected error occurred while retrieving roles & permissions'),
      500
    );
  }
};
