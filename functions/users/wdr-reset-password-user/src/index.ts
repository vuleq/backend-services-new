import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
  AdminDeleteUserCommand,
  DescribeUserPoolCommand,
  MessageActionType
} from '@aws-sdk/client-cognito-identity-provider';
import { executeQuery, performTransaction, Operation } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES } from 'wdr-error-codes';

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';

interface User {
  id: string;
  name: string;
  email: string;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Validate input
    if (!event.body) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Request body is required'));
    }

    const users: User[] = JSON.parse(event.body);
    if (!Array.isArray(users) || users.length === 0) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid users data'));
    }

    // Get tables with created_by and updated_by fields
    const tablesWithUserFields = await getTablesWithUserFields();

    // Process each user
    const results = await Promise.all(users.map(async (user) => {
      try {
        // Create user in Cognito
        const cognitoUser:any = await createCognitoUser(user);
        const cognitoUserId = cognitoUser.User?.Username;

        if (!cognitoUserId) {
          throw new Error('Failed to get Cognito user ID');
        }

        // Create new user in database with Cognito ID
        await createNewUser(user, cognitoUserId);

        // Update related tables
        await updateRelatedTables(user.id, cognitoUserId, tablesWithUserFields);

        // Delete old user
        await deleteOldUser(user.id);

        return { oldId: user.id, newId: cognitoUserId, status: 'success' };
      } catch (error) {
        return {
          oldId: user.id,
          newId: null,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }));

    const successCount = results.filter(r => r.status === 'success').length;
    const failedResults = results.filter(r => r.status === 'failed');

    return new LambdaResponse(200, new ApiResponse(true, {
      results,
      failed: failedResults.length > 0 ? failedResults : null
    },`Processed ${successCount} users successfully`));

  } catch (error) {
    console.error('Error processing users:', error);
    return new LambdaResponse(
      500,
      new ApiResponse(false, null, ERROR_CODES.INTERNAL_SERVER_ERROR.defaultMessage)
    );
  }
};

async function createCognitoUser(user: User) {
  const createUserCommand = new AdminCreateUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: user.email,
    UserAttributes: [
      { Name: 'email', Value: user.email },
      { Name: 'name', Value: user.name },
      { Name: 'email_verified', Value: 'true' }
    ],
    MessageAction: MessageActionType.SUPPRESS
  });

  const response = await cognitoClient.send(createUserCommand);
  return response.User;
}

async function createNewUser(user: User, cognitoId: string) {
  const query = `
    INSERT INTO users (id, name, email, cognito_id)
    VALUES ($1, $2, $3, $4)
  `;
  await executeQuery(query, [cognitoId, user.name, user.email, cognitoId]);
}

async function getTablesWithUserFields(): Promise<string[]> {
  const query = `
    SELECT table_name
    FROM information_schema.columns
    WHERE column_name IN ('created_by', 'updated_by')
    GROUP BY table_name
    HAVING count(*) > 0
  `;
  const result = await executeQuery(query);
  return result.data.map((row: any) => row.table_name);
}

async function updateRelatedTables(oldUserId: string, newUserId: string, tables: string[]) {
  const operations: Operation[] = tables.flatMap(table => [
    {
      type: 'query',
      queryText: `UPDATE ${table} SET created_by = $1 WHERE created_by = $2`,
      params: [newUserId, oldUserId]
    },
    {
      type: 'query',
      queryText: `UPDATE ${table} SET updated_by = $1 WHERE updated_by = $2`,
      params: [newUserId, oldUserId]
    }
  ]);

  await performTransaction(operations);
}


async function deleteOldUser(userId: string) {
  const query = 'DELETE FROM users WHERE id = $1';
  await executeQuery(query, [userId]);
}