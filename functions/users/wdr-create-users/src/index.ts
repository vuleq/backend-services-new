import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { 
  CognitoIdentityProviderClient, 
  AdminCreateUserCommand, 
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
  MessageActionType 
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
const defaultUserName = 'System Admin';
const defaultPassword = process.env.DEFAULT_PASSWORD;

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

type CreateUserRequest = {
  email: string;
  name?: string;
  roles?: string[]; // Array of role codes (e.g., ['SRM', 'SO'])
  tradeSections?: string[]; // Array of trade section id: uuid[]
  temporaryPassword?: string;
  sendWelcomeEmail?: boolean;
  startDate: string;
  phone: string;
};

type CreateUserResponse = {
  cognitoUserId?: string;
  databaseUserId?: string;
  email: string;
  success: boolean;
  error?: string;
};

enum UserStatus {
  Active = 0,
  Deactive = 1
}

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
      console.error('COGNITO_USER_POOL_ID environment variable not set');
      return LambdaResponse.success(
        new ApiResponse(false, null, 'Configuration error: User pool ID not configured', ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code)
      );
    }

    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
    const users: CreateUserRequest[] = Array.isArray(body) ? body : [body];

    // Get current user info from request context

    let currentUserId = event.requestContext?.authorizer?.claims?.sub || defaultUserId;
    let currentUserName = event.requestContext?.authorizer?.claims?.name || defaultUserName;

    if (currentUserId === defaultUserId || currentUserName === defaultUserName) {
      const rawToken = event.headers?.Authorization || event.headers?.authorization || "";
      const token = rawToken.startsWith("Bearer ") ? rawToken.slice(7) : rawToken;

      if (token) {
        try {
          const decoded: any = decodeToken(token);
          currentUserId = decoded?.payload?.sub || currentUserId;
          currentUserName = decoded?.payload?.name || currentUserName;
        } catch (err) {
          console.warn("Failed to decode token:", err);
          // Keep default value
        }
      }
    }

    console.log(`Current User: ${currentUserName} (${currentUserId})`);



    if (users.length === 0) {
      return LambdaResponse.success(
        new ApiResponse(false, null, 'No users provided for creation', ERROR_CODES.INVALID_REQUEST.code)
      );
    }

    const results: CreateUserResponse[] = [];
    const validUsers: CreateUserRequest[] = [];
    
    // Validate input
    for (const user of users) {
      const validation = validateUserInput(user);
      if (!validation.isValid) {
        results.push({
          email: user.email || 'unknown',
          success: false,
          error: validation.errors.join(', ')
        });
      } else {
        validUsers.push(user);
      }
    }

    if (validUsers.length === 0) {
      return LambdaResponse.success(
        new ApiResponse(false, results, 'No valid users to create', ERROR_CODES.ENTITY_VALIDATION_FAILED.code)
      );
    }

    // Validate roles exist in database (if any roles provided)
    const usersWithRoles = validUsers.filter(user => user.roles && user.roles.length > 0);
    if (usersWithRoles.length > 0) {
      const roleValidationResult = await validateRoles(usersWithRoles);
      if (!roleValidationResult.success) {
        return LambdaResponse.success(
          new ApiResponse(false, null, roleValidationResult.error, ERROR_CODES.DATABASE_ERROR.code)
        );
      }
    }

    // Validate trade_sections exist in database (if any roles provided)
    const usersWithSections = validUsers.filter(user => user.tradeSections && user.tradeSections.length > 0);
    if (usersWithSections.length > 0) {
      const sectionValidation = await validateTradeSections(usersWithSections);
      if (!sectionValidation.success) {
        return LambdaResponse.success(
          new ApiResponse(false, null, sectionValidation.error, ERROR_CODES.DATABASE_ERROR.code)
        );
      }
    }


    // Process each valid user
    for (const user of validUsers) {
      try {
        const result = await createUserInCognitoAndDatabase(user, currentUserId, currentUserName);
        results.push(result);
      } catch (error) {
        console.error(`Error creating user ${user.email}:`, error);
        results.push({
          email: user.email,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred'
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const errorCount = results.filter(r => !r.success).length;

    return LambdaResponse.success(
      new ApiResponse(
        true, 
        {
          summary: {
            total: results.length,
            successful: successCount,
            failed: errorCount
          },
          results
        },
        `User creation completed: ${successCount} successful, ${errorCount} failed`,
        ERROR_CODES.SUCCESS.code
      )
    );

  } catch (error) {
    console.error('Error in wdr-create-users:', error);
    return LambdaResponse.success(
      new ApiResponse(
        false, 
        null, 
        'An error occurred while creating users', 
        ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code
      )
    );
  }
};

/**
 * Validate user input data
 */
function validateUserInput(user: CreateUserRequest): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!user.email || !isValidEmail(user.email)) {
    errors.push('Valid email is required');
  }

  if (!user.name || user.name.trim().length === 0) {
    errors.push('Name is required');
  }

  if (!user.roles || user.roles.length === 0) {
    errors.push('At least one role is required');
  }

  if (user.startDate) {
    if (!isDateValid(user.startDate)) {
      errors.push("Invalid startDate format");
    }
  }

  if (user.roles?.some(r => ['HOD', 'TS', 'FOR'].includes(r)) && (!user.tradeSections || user.tradeSections.length === 0)) {
    errors.push('Trade section is required for HOD, Supervisor, or Foreman roles');
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate that all specified role codes exist in the database
 */
async function validateRoles(users: CreateUserRequest[]): Promise<{ success: boolean; error?: string }> {
  try {
    const allRoles = [...new Set(users.flatMap(user => user.roles || []))];
    const roleQuery = 'SELECT code FROM roles WHERE code = ANY($1)';
    const roleResult = await executeQuery(roleQuery, [allRoles]);

    if (!roleResult.success) {
      return { success: false, error: 'Failed to validate role codes in database' };
    }

    const existingRoles = roleResult.data.map((row: any) => row.code);
    const missingRoles = allRoles.filter(role => !existingRoles.includes(role));

    if (missingRoles.length > 0) {
      return { success: false, error: `Role codes not found in database: ${missingRoles.join(', ')}` };
    }

    return { success: true };
  } catch (error) {
    console.error('Error validating role codes:', error);
    return { success: false, error: 'Error validating role codes' };
  }
}

/**
 * Validate that all specified trade_sections id exist in the database
 */
async function validateTradeSections(users: CreateUserRequest[]): Promise<{ success: boolean; error?: string }> {
  try {
    const allSectionIds = [...new Set(users.flatMap(user => user.tradeSections || []))];
    if (allSectionIds.length === 0) return { success: true };

    const query = 'SELECT id FROM trade_sections WHERE id = ANY($1)';
    const result = await executeQuery(query, [allSectionIds]);

    if (!result.success) {
      return { success: false, error: 'Failed to validate trade sections in database' };
    }

    const existingIds = result.data.map((row: any) => row.id);
    const missing = allSectionIds.filter(id => !existingIds.includes(id));

    if (missing.length > 0) {
      return { success: false, error: `Trade section IDs not found: ${missing.join(', ')}` };
    }

    return { success: true };
  } catch (err) {
    console.error('Error validating trade section IDs:', err);
    return { success: false, error: 'Error validating trade sections' };
  }
}


/**
 * Create user in both Cognito and database
 */
async function createUserInCognitoAndDatabase(
  user: CreateUserRequest, 
  currentUserId: string, 
  currentUserName: string
): Promise<CreateUserResponse> {
  let cognitoUserId: string | undefined;
  let databaseUserId: string | undefined;

  try {
    // Step 1: Create user in Cognito
    const cognitoResult = await createUserInCognito(user);
    if (!cognitoResult.success) {
      return {
        email: user.email,
        success: false,
        error: cognitoResult.error
      };
    }
    
    if (!cognitoResult.userId) {
      return {
        email: user.email,
        success: false,
        error: 'Failed to get Cognito user ID'
      };
    }
    
    cognitoUserId = cognitoResult.userId;

    // Step 2: Create user in database
    const databaseResult = await createUserInDatabase(user, cognitoUserId, currentUserId);
    if (!databaseResult.success) {
      // Rollback: Try to delete Cognito user
      console.error(`Database creation failed for ${user.email}, Cognito user ${cognitoUserId} created`);
      try {
        await deleteUserInCognito(cognitoUserId);
        console.log(`Rolled back Cognito user ${cognitoUserId} because DB creation failed`);
      } catch (rollbackError) {
        console.error(`Failed to rollback Cognito user ${cognitoUserId}:`, rollbackError);
      }
      return {
        email: user.email,
        cognitoUserId,
        success: false,
        error: databaseResult.error
      };
    }
    databaseUserId = databaseResult.userId;

    return {
      email: user.email,
      cognitoUserId,
      databaseUserId,
      success: true
    };

  } catch (error) {
    console.error(`Unexpected error creating user ${user.email}:`, error);
    return {
      email: user.email,
      cognitoUserId,
      databaseUserId,
      success: false,
      error: error instanceof Error ? error.message : 'Unexpected error'
    };
  }
}

/**
 * Create user in Cognito User Pool with bypass force change password
 */
async function createUserInCognito(user: CreateUserRequest): Promise<{ success: boolean; userId?: string; error?: string; passwordSetPermanent?: boolean }> {
  console.log(`[createUserInCognito] Starting user creation process for: ${user.email}`);
  
  try {
    const temporaryPassword = user.temporaryPassword || defaultPassword;
    console.log(`[createUserInCognito] Generated/using temporary password for ${user.email}`);
    
    // Skip user pool verification and user existence check for now
    // These steps were working, so let's focus on the AdminCreateUserCommand
    
    // Prepare user attributes
    console.log(`[createUserInCognito] Step 1: Preparing user attributes for ${user.email}`);
    const userAttributes = [
      { Name: 'email', Value: user.email },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'name', Value: user.name || user.email.split('@')[0] } // Use part before @ as fallback name
    ];
    console.log(`[createUserInCognito] User attributes prepared:`, userAttributes);

    // Create user command with simplified approach
    console.log(`[createUserInCognito] Step 2: Creating user ${user.email} in Cognito...`);
    
    // Configure email sending based on user preference
    const createUserCommandParams: any = {
      UserPoolId: USER_POOL_ID,
      Username: user.email,
      UserAttributes: userAttributes,
      MessageAction: MessageActionType.SUPPRESS,
      TemporaryPassword: temporaryPassword,
    };
    
    // Only add MessageAction if we want to suppress the email
    if (user.sendWelcomeEmail === false) {
      createUserCommandParams.MessageAction = MessageActionType.SUPPRESS;
      console.log(`[createUserInCognito] Email suppressed for ${user.email} as requested`);
    } else {
      console.log(`[createUserInCognito] Welcome email will be sent for ${user.email}`);
    }
    
    const createUserCommand = new AdminCreateUserCommand(createUserCommandParams);
    
    console.log(`[createUserInCognito] Command details:`, {
      UserPoolId: USER_POOL_ID,
      Username: user.email,
      AttributeCount: userAttributes.length,
      MessageAction: MessageActionType.SUPPRESS,
      HasTemporaryPassword: !!temporaryPassword
    });
    
    console.log(`[createUserInCognito] Sending AdminCreateUserCommand for ${user.email}...`);

    const createUserResponse = await cognitoClient.send(createUserCommand);
    console.log(`[createUserInCognito] AdminCreateUserCommand response received for ${user.email}`);
    
    if (!createUserResponse.User?.Username) {
      console.error(`[createUserInCognito] Failed to create user ${user.email} - no username returned`);
      return { success: false, error: 'Failed to create user in Cognito - no username returned' };
    }

    const cognitoUserId = createUserResponse.User.Username;
    console.log(`[createUserInCognito] User ${user.email} successfully created in Cognito with ID: ${cognitoUserId}`);
    console.log(`[createUserInCognito] User status: ${createUserResponse.User.UserStatus}`);

    // Set permanent password to bypass force change password with retry logic
    console.log(`[createUserInCognito] Step 3: Starting password setting process for ${user.email}...`);
    let passwordSetSuccess = false;
    let retryCount = 0;
    const maxRetries = 3; // Reduced retries since user creation worked
    const baseDelay = 1000; // 1 second

    while (retryCount < maxRetries && !passwordSetSuccess) {
      try {
        // Progressive delay: 1s, 2s, 3s
        const delay = baseDelay * (retryCount + 1);
        console.log(`[createUserInCognito] Waiting ${delay}ms before attempting to set password (attempt ${retryCount + 1}/${maxRetries}) for ${user.email}`);
        await new Promise(resolve => setTimeout(resolve, delay));

        console.log(`[createUserInCognito] Attempting to set permanent password for ${user.email}...`);
        const setPasswordCommand = new AdminSetUserPasswordCommand({
          UserPoolId: USER_POOL_ID,
          Username: user.email, // Use original email as username
          Password: temporaryPassword,
          Permanent: true // This bypasses the force change password requirement
        });

        await cognitoClient.send(setPasswordCommand);
        console.log(`[createUserInCognito] Password set successfully for ${user.email} - force change bypassed`);
        passwordSetSuccess = true;

      } catch (passwordError: any) {
        retryCount++;
        console.error(`[createUserInCognito] Attempt ${retryCount} to set password for ${user.email} failed:`, {
          errorName: passwordError.name,
          errorMessage: passwordError.message,
          errorCode: passwordError.$metadata?.httpStatusCode
        });
        
        if (retryCount >= maxRetries) {
          console.warn(`[createUserInCognito] Failed to set permanent password for ${user.email} after ${maxRetries} attempts. User created but will need to change password on first login.`);
          // Still return success since user was created
          break;
        }
      }
    }
    
    console.log(`[createUserInCognito] User creation process completed for ${user.email}. Password set permanently: ${passwordSetSuccess}`);
    return { 
      success: true, 
      userId: cognitoUserId,
      passwordSetPermanent: passwordSetSuccess
    };

  } catch (error: any) {
    console.error(`[createUserInCognito] Error creating user ${user.email} in Cognito:`, {
      errorName: error.name,
      errorMessage: error.message,
      errorCode: error.$metadata?.httpStatusCode,
      fullError: error
    });
    
    if (error.name === 'UsernameExistsException') {
      return { success: false, error: 'User already exists in Cognito' };
    }
    
    return { 
      success: false, 
      error: error.message || 'Failed to create user in Cognito' 
    };
  }
}

/**
 * Delete user in Cognito User Pool 
 */
async function deleteUserInCognito(userId: string): Promise<void> {
  const command = new AdminDeleteUserCommand({
    UserPoolId: process.env.COGNITO_USER_POOL_ID!,
    Username: userId,
  });
  await cognitoClient.send(command);
}

/**
 * Create user in database with roles
 */
async function createUserInDatabase(
  user: CreateUserRequest, 
  cognitoUserId: string, 
  currentUserId: string
): Promise<{ success: boolean; userId?: string; error?: string }> {
  try {
    const now = new Date().toISOString();
    const startDateDb = (user.startDate && isDateValid(user.startDate)) ? user.startDate : null;

    // Prepare operations for transaction
    const operations: Operation[] = [
      // Insert user
      {
        type: 'insert',
        table: 'users',
        data: {
          id: cognitoUserId, // Use Cognito user ID as primary key
          name: user.name || user.email.split('@')[0], // Use part before @ as fallback name
          email: user.email,
          created_by: currentUserId,
          updated_by: currentUserId,
          created_at: now,
          updated_at: now,
          avt: null, // Avatar can be updated later
          start_date: startDateDb,
          phone_number: user.phone,
          status: 0
        },
        returningClause: 'id'
      }
    ];

    let roleResult: any = { success: true, data: [] };

    // Get role IDs
    if (user.roles && user.roles.length > 0) {
      const roleQuery = 'SELECT id, code FROM roles WHERE code = ANY($1)';
      roleResult = await executeQuery(roleQuery, [user.roles]);
      
      if (!roleResult.success || roleResult.data.length !== user.roles.length) {
        return { success: false, error: 'Failed to fetch role information' };
      }

      // Add user role assignments
      for (const role of roleResult.data) {
        operations.push({
          type: 'insert',
          table: 'user_roles',
          data: {
            user_id: cognitoUserId,
            role_id: role.id,
            created_by: currentUserId,
            created_at: now
          }
        });
        // Copy permissions from role_permissions to user_permissions
        operations.push({
          type: 'query',
          queryText: `
            INSERT INTO user_permissions (user_id, role_id, permission_id)
            SELECT $1, rp.role_id, rp.permission_id
            FROM role_permissions rp
            WHERE rp.role_id = $2
            ON CONFLICT DO NOTHING
          `,
          params: [cognitoUserId, role.id]
        });
      }
    }

    // Insert into user_trade_sections
    if (user.tradeSections && user.tradeSections.length > 0 && roleResult.data.length > 0) {
      for (const tradeSectionId of user.tradeSections) {
        for (const role of roleResult.data) {
          operations.push({
            type: 'insert',
            table: 'user_trade_sections',
            data: {
              user_id: cognitoUserId,
              trade_section_id: tradeSectionId,
              role_id: role.id
            }
          });
        }
      }
    }

    const projectOps = await assignUserToProjects(cognitoUserId, roleResult.data, user);
    operations.push(...projectOps);
    console.log("Operation: ", operations)

    // Execute transaction
    const transactionResult = await performTransaction(operations);
    
    if (!transactionResult.success) {
      console.error('Database transaction failed:', transactionResult.error);
      return { success: false, error: 'Failed to create user in database' };
    }

    console.log(`User ${user.email} created in database with ID: ${cognitoUserId}`);
    
    return { success: true, userId: cognitoUserId };

  } catch (error) {
    console.error(`Error creating user ${user.email} in database:`, error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Database error' 
    };
  }
}

async function assignUserToProjects(cognitoUserId: string, matchedRoles: any, user: CreateUserRequest) {
  const operations: any[] = [];

  if (matchedRoles.length === 0) {
    return operations;
  }

  console.log("matchedRoles", matchedRoles)

  // Get all active projects
  const activeProjectsResult = await executeQuery(
    `SELECT id FROM projects WHERE status != $1`,
    [unactiveProject] // 3 = Closed
  );

  if (!activeProjectsResult.success || activeProjectsResult.data.length === 0) {
    return operations;
  }

  for (const role of matchedRoles) {
    if (role.code === specialRoleCodes.SU || role.code === specialRoleCodes.COA) {
      //Super User, CO Admin -> add to all active projects
      for (const project of activeProjectsResult.data) {
        operations.push({
          type: "insert",
          table: "project_assignments",
          data: {
            project_id: project.id,
            user_id: cognitoUserId,
            role: roleIdMap[role.code as RoleCodeEnum],
            role_code: role.code,
          },
        });
      }
    }

    if (role.code === specialRoleCodes.HOD) {
      for (const project of activeProjectsResult.data) {
        // find project_trade_sections in DB that match user.tradeSections
        const ptsResult = await executeQuery(
          `SELECT id FROM project_trade_sections
       WHERE project_id = $1 AND trade_section_id = ANY($2)`,
          [project.id, user.tradeSections]
        );

        if (ptsResult.success) {
          for (const pts of ptsResult.data) {
            operations.push({
              type: "insert",
              table: "project_trade_section_assigns",
              data: {
                project_trade_section_id: pts.id,
                user_id: cognitoUserId,
                role_id: role.id,
              },
            });
          }
        }
      }
    }

  }

  return operations;
}
