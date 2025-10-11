import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { executeQuery, performTransaction, Operation } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES } from 'wdr-error-codes';
import { decodeToken } from 'wdr-common-utils';

// Initialize Cognito client
const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION
});

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const defaultUserId = '00000000-0000-0000-0000-000000000000';
const specialRoleCodes = {
  SU: "SU",
  COA: "COA",
  HOD: "HOD",
};

enum RoleCodeEnum {
  "Super User" = "SU",
  "SRM" = "SRM",
  "Safety Officer" = "SO",
  "Commercial Officer Admin" = "COA",
  "Commercial Officer" = "CO",
  "Guest" = "GUEST",
}

const roleIdMap: Record<RoleCodeEnum, number> = {
  [RoleCodeEnum["Super User"]]: 0,
  [RoleCodeEnum.SRM]: 1,
  [RoleCodeEnum["Safety Officer"]]: 2,
  [RoleCodeEnum["Commercial Officer Admin"]]: 3,
  [RoleCodeEnum["Commercial Officer"]]: 4,
  [RoleCodeEnum.Guest]: 5,
};

const unactiveProject: number = 3

type Role = { id: string; code: string };

type UpdateUserRequest = {
  userId: string;
  email?: string;
  name?: string;
  roles?: string[];
  tradeSections?: string[];
  newPassword?: string;
  startDate?: string;
  phone?: string;
};

type UpdateUserResponse = {
  userId: string;
  success: boolean;
  error?: string;
};

function isDateValid(dateString: string): boolean {
  if (!dateString || typeof dateString !== 'string') {
    return false;
  }
  const date = new Date(dateString);
  return !isNaN(date.getTime()) && dateString.length >= 10;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Received event:', JSON.stringify(event, null, 2));
    console.log('Environment variables:', {
      AWS_REGION: process.env.AWS_REGION,
      COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
      NODE_ENV: process.env.NODE_ENV
    });

    if (!USER_POOL_ID) {
      return LambdaResponse.success(
        new ApiResponse(false, null, "Configuration error: User pool ID not configured", ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code)
      );
    }

    const userIdFromPath = event.pathParameters?.userId;
    if (!userIdFromPath) {
      return LambdaResponse.success(
        new ApiResponse(false, null, "User ID is required", ERROR_CODES.INVALID_REQUEST.code)
      );
    }

    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};

    const user: UpdateUserRequest = {
      userId: userIdFromPath,
      email: body.email,
      name: body.name,
      roles: body.roles,
      tradeSections: body.tradeSections,
      newPassword: body.newPassword,
      startDate: body.startDate,
      phone: body.phone
    };

    // --- Get current user info ---
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

    // --- Validate input ---
    const validation = validateUserInput(user);
    if (!validation.isValid) {
      return LambdaResponse.success(
        new ApiResponse(false, null, validation.errors.join(", "), ERROR_CODES.ENTITY_VALIDATION_FAILED.code)
      );
    }

    // --- Validate roles ---
    if (user.roles?.length) {
      const roleValidation = await validateRoles([user]);
      if (!roleValidation.success) {
        return LambdaResponse.success(
          new ApiResponse(false, null, roleValidation.error, ERROR_CODES.DATABASE_ERROR.code)
        );
      }
    }

    // --- Validate trade sections ---
    if (user.tradeSections?.length) {
      const sectionValidation = await validateTradeSections([user]);
      if (!sectionValidation.success) {
        return LambdaResponse.success(
          new ApiResponse(false, null, sectionValidation.error, ERROR_CODES.DATABASE_ERROR.code)
        );
      }
    }

    // --- Update user ---
    try {
      const result = await updateUserInCognitoAndDatabase(user, currentUserId);

      if (!result.success) {
        return LambdaResponse.success(
          new ApiResponse(false, result, result.error, ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code)
        );
      }

      return LambdaResponse.success(
        new ApiResponse(true, result, "User update successful", ERROR_CODES.SUCCESS.code)
      );
    } catch (err) {
      console.error("Error updating user:", err);
      return LambdaResponse.success(
        new ApiResponse(false, null, err instanceof Error ? err.message : "Unknown error", ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code)
      );
    }
  } catch (error) {
    console.error("Error in update-user lambda:", error);
    return LambdaResponse.success(
      new ApiResponse(false, null, "An error occurred while updating user", ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code)
    );
  }
};

/**
 * Validate user input
 */
function validateUserInput(user: UpdateUserRequest): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!user.userId) {
    errors.push('User ID is required');
  }
  if (user.email && !isValidEmail(user.email)) {
    errors.push('Invalid email format');
  }

  if (user.name !== undefined && user.name.trim() === "") {
    errors.push('Name cannot be empty');
  }

  if (user.roles !== undefined && user.roles.length === 0) {
    errors.push('Roles cannot be empty');
  }

  if (user.startDate) {
    if (!isDateValid(user.startDate)) {
      errors.push("Invalid startDate format");
    }
  }

  return { isValid: errors.length === 0, errors };
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

async function validateRoles(users: UpdateUserRequest[]): Promise<{ success: boolean; error?: string }> {
  try {
    const allRoles = [...new Set(users.flatMap(u => u.roles || []))];
    const query = 'SELECT code FROM roles WHERE code = ANY($1)';
    const res = await executeQuery(query, [allRoles]);
    if (!res.success) return { success: false, error: 'Failed to validate roles in database' };

    const existing = res.data.map((r: any) => r.code);
    const missing = allRoles.filter(r => !existing.includes(r));
    if (missing.length > 0) {
      return { success: false, error: `Role codes not found: ${missing.join(', ')}` };
    }
    return { success: true };
  } catch (err) {
    console.error('Error validating roles:', err);
    return { success: false, error: 'Error validating roles' };
  }
}

async function validateTradeSections(users: UpdateUserRequest[]): Promise<{ success: boolean; error?: string }> {
  try {
    const allSections = [...new Set(users.flatMap(u => u.tradeSections || []))];
    if (allSections.length === 0) return { success: true };

    const query = 'SELECT id FROM trade_sections WHERE id = ANY($1)';
    const res = await executeQuery(query, [allSections]);
    if (!res.success) return { success: false, error: 'Failed to validate trade sections' };

    const existing = res.data.map((r: any) => r.id);
    const missing = allSections.filter(id => !existing.includes(id));
    if (missing.length > 0) {
      return { success: false, error: `Trade section IDs not found: ${missing.join(', ')}` };
    }
    return { success: true };
  } catch (err) {
    console.error('Error validating trade sections:', err);
    return { success: false, error: 'Error validating trade sections' };
  }
}

/**
 * Update user in Cognito and Database
 */
async function updateUserInCognitoAndDatabase(user: UpdateUserRequest, currentUserId: string): Promise<UpdateUserResponse> {
  try {

    const dbResult = await updateUserInDatabase(user, currentUserId);
    if (!dbResult.success) {
      return { userId: user.userId, success: false, error: dbResult.error };
    }
    
    const cognitoResult = await updateUserInCognito(user);
    if (!cognitoResult.success) {
      return { userId: user.userId, success: false, error: cognitoResult.error };
    }

    return { userId: user.userId, success: true };
  } catch (err) {
    console.error(`Error updating user ${user.userId}:`, err);
    return { userId: user.userId, success: false, error: err instanceof Error ? err.message : 'Unexpected error' };
  }
}

/**
 * Update Cognito user
 */
async function updateUserInCognito(user: UpdateUserRequest): Promise<{ success: boolean; error?: string }> {
  try {
    const attributes: { Name: string; Value: string }[] = [];
    if (user.email) {
      attributes.push({ Name: 'email', Value: user.email });
      attributes.push({ Name: 'email_verified', Value: 'true' });
    }
    if (user.name) {
      attributes.push({ Name: 'name', Value: user.name });
    }

    if (attributes.length > 0) {
      await cognitoClient.send(new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: user.userId,
        UserAttributes: attributes
      }));
    }

    if (user.newPassword) {
      await cognitoClient.send(new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: user.userId,
        Password: user.newPassword,
        Permanent: true
      }));
    }

    return { success: true };
  } catch (err: any) {
    console.error(`[updateUserInCognito] Error:`, err);
    return { success: false, error: err.message || 'Failed to update Cognito user' };
  }
}

/**
 * Update Database user
 */
async function updateUserInDatabase(user: UpdateUserRequest, currentUserId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const now = new Date().toISOString();
    const operations: Operation[] = [
      {
        type: 'update',
        table: 'users',
        data: {
          ...(user.name ? { name: user.name } : {}),
          ...(user.email ? { email: user.email } : {}),
          ...(user.startDate ? { start_date: user.startDate } : {}),
          ...(user.phone ? { phone_number: user.phone } : {}),
          updated_by: currentUserId,
          updated_at: now
        },
        condition: { id: user.userId }
      }
    ];

    // roles
    let roleObjs: Role[] = [];
    if (user.roles !== undefined) {
      console.log("[updateUserInDatabase] Handling roles:", user.roles);
      const roleOps = await buildRoleOps(user.userId, user.roles, user.tradeSections, currentUserId, now);
      for (const op of roleOps) operations.push(op);

      roleObjs = await getRolesByCodes(user.roles);
      console.log("[updateUserInDatabase] Final role objects:", roleObjs);
    }

    // trade sections
    if (user.tradeSections !== undefined) {
      console.log("[updateUserInDatabase] Handling tradeSections:", user.tradeSections);
      const tsOps = await buildTradeSectionOps(user.userId, user.tradeSections, roleObjs);
      for (const op of tsOps) operations.push(op);
    }
    console.log("[updateUserInDatabase] Operations to execute:", JSON.stringify(operations, null, 2));

    const trx = await performTransaction(operations);
    if (!trx.success) {
      return { success: false, error: trx.error || "Database update failed" };
    }

    return { success: true };
  } catch (err) {
    console.error(`[updateUserInDatabase] Error:`, err);
    return { success: false, error: err instanceof Error ? err.message : "Database error" };
  }
}

function diffArrays(existing: string[], incoming: string[]) {
  const toAdd = incoming.filter((x) => !existing.includes(x));
  const toRemove = existing.filter((x) => !incoming.includes(x));
  return { toAdd, toRemove };
}

async function getRolesByCodes(codes: string[]): Promise<Role[]> {
  if (!codes.length) return [];
  const res = await executeQuery("SELECT id, code FROM roles WHERE code = ANY($1)", [codes]);
  if (!res.success) throw new Error("Failed to fetch roles");
  return res.data;
}

async function getUserRoles(userId: string): Promise<Role[]> {
  const res = await executeQuery(
    `SELECT r.id, r.code 
     FROM user_roles ur 
     JOIN roles r ON ur.role_id = r.id 
     WHERE ur.user_id = $1`,
    [userId]
  );
  if (!res.success) throw new Error("Failed to fetch current user roles");
  return res.data;
}

async function buildRoleOps(userId: string, newCodes: string[], tradeSections: any, currentUserId: string, now: string): Promise<Operation[]> {
  const ops: Operation[] = [];
  if (newCodes.length === 0) {
    // remove all roles + permissions
    ops.push({
      type: "query",
      queryText: "DELETE FROM user_roles WHERE user_id = $1",
      params: [userId],
    });
    ops.push({
      type: "query",
      queryText: "DELETE FROM user_permissions WHERE user_id = $1",
      params: [userId],
    });
    return ops;
  }

  const existingRoles = await getUserRoles(userId);
  const existingCodes = existingRoles.map((r) => r.code);
  const { toAdd, toRemove } = diffArrays(existingCodes, newCodes);

  const toAddRoles = await getRolesByCodes(toAdd);
  const toRemoveRoles = existingRoles.filter((r) => toRemove.includes(r.code));
  console.log("[buildRoleOps] existingCodes:", existingCodes);
  console.log("[buildRoleOps] newCodes:", newCodes);
  console.log("[buildRoleOps] toAdd:", toAdd, "toRemove:", toRemove);

  // remove roles
  for (const role of toRemoveRoles) {
    console.log("[buildRoleOps] Removing role:", role);
    ops.push({
      type: "delete",
      table: "user_roles",
      condition: { user_id: userId, role_id: role.id },
    });
    ops.push({
      type: "delete",
      table: "user_permissions",
      condition: { user_id: userId, role_id: role.id },
    });
  }

  // add roles
  for (const role of toAddRoles) {
    console.log("[buildRoleOps] Adding role:", role);
    ops.push({
      type: "insert",
      table: "user_roles",
      data: {
        user_id: userId,
        role_id: role.id,
        created_by: currentUserId,
        created_at: now,
      },
    });
    ops.push({
      type: "query",
      queryText: `
        INSERT INTO user_permissions (user_id, role_id, permission_id)
        SELECT $1, rp.role_id, rp.permission_id
        FROM role_permissions rp
        WHERE rp.role_id = $2
        ON CONFLICT DO NOTHING
      `,
      params: [userId, role.id],
    });
  }

  // projects sync
  const removeOps = await removeUserFromProjectsOnRemove(userId, toRemoveRoles);
  for (const op of removeOps) ops.push(op);

  const addOps = await assignUserToProjectsOnAdd(userId, toAddRoles, tradeSections);
  for (const op of addOps) ops.push(op);

  return ops;
}

async function buildTradeSectionOps(userId: string, newTS: string[], roles: Role[]): Promise<Operation[]> {
  const ops: Operation[] = [];
  if (newTS.length === 0) {
    ops.push({
      type: "delete",
      table: "user_trade_sections",
      condition: { user_id: userId },
    });
    return ops;
  }

  const res = await executeQuery(
    `SELECT trade_section_id FROM user_trade_sections WHERE user_id = $1`,
    [userId]
  );
  if (!res.success) throw new Error("Failed to fetch current trade sections");

  const existingTS = res.data.map((r: { trade_section_id: string }) => r.trade_section_id);
  const { toAdd, toRemove } = diffArrays(existingTS, newTS);

  console.log("[buildTradeSectionOps] existingTS:", existingTS);
  console.log("[buildTradeSectionOps] newTS:", newTS);
  console.log("[buildTradeSectionOps] toAdd:", toAdd, "toRemove:", toRemove);

  if (toRemove.length) {
    ops.push({
      type: "query",
      queryText: `DELETE FROM user_trade_sections WHERE user_id = $1 AND trade_section_id = ANY($2)`,
      params: [userId, toRemove],
    });
  }

  if (toAdd.length && roles.length) {
    for (const ts of toAdd) {
      for (const role of roles) {
        console.log("[buildTradeSectionOps] Adding tradeSection:", ts, "role:", role);
        ops.push({
          type: "insert",
          table: "user_trade_sections",
          data: {
            user_id: userId,
            trade_section_id: ts,
            role_id: role.id,
          },
        });
      }
    }
  }

  return ops;
}

async function assignUserToProjectsOnAdd(
  userId: string,
  roles: Role[],
  tradeSections: string[] = []
): Promise<Operation[]> {
  const ops: Operation[] = [];
  if (!roles.length) return ops;

  const activeProjectsRes = await executeQuery(
    `SELECT id FROM projects WHERE status != $1`,
    [unactiveProject]
  );
  if (!activeProjectsRes.success || !activeProjectsRes.data.length) return ops;

  const activeProjects = activeProjectsRes.data;

  for (const role of roles) {
    // Super User, CO Admin → add vào project_assignments
    if (role.code === specialRoleCodes.SU || role.code === specialRoleCodes.COA) {
      for (const project of activeProjects) {
        ops.push({
          type: "insert",
          table: "project_assignments",
          data: {
            project_id: project.id,
            user_id: userId,
            role: roleIdMap[role.code as RoleCodeEnum],
            role_code: role.code,
          },
        });
      }
    }

    // Head of Department → add vào project_trade_section_assigns
    if (role.code === specialRoleCodes.HOD && tradeSections.length) {
      for (const project of activeProjects) {
        const ptsResult = await executeQuery(
          `SELECT id FROM project_trade_sections
           WHERE project_id = $1 AND trade_section_id = ANY($2)`,
          [project.id, tradeSections]
        );

        console.log("ptsResult", ptsResult.data)

        if (ptsResult.success && ptsResult.data.length) {
          for (const pts of ptsResult.data) {
            ops.push({
              type: "insert",
              table: "project_trade_section_assigns",
              data: {
                project_trade_section_id: pts.id,
                user_id: userId,
                role_id: role.id,
              },
            });
          }
        }
      }
    }
  }

  return ops;
}

async function removeUserFromProjectsOnRemove(userId: string, roles: Role[]): Promise<Operation[]> {
  const ops: Operation[] = [];
  for (const role of roles) {
    const roleEnumId = roleIdMap[role.code as RoleCodeEnum];
    if (role.code === specialRoleCodes.SU || role.code === specialRoleCodes.COA) {
      ops.push({
        type: "query",
        queryText: `
          DELETE FROM project_assignments
          WHERE user_id = $1
          AND (role = $2 OR role_code = $3)
        `,
        params: [userId, roleEnumId, role.code],
      });
    }
    if (role.code === specialRoleCodes.HOD) {
      ops.push({
        type: "query",
        queryText: `DELETE FROM project_trade_section_assigns WHERE user_id = $1 AND role_id = $2`,
        params: [userId, role.id],
      });
    }
  }
  return ops;
}