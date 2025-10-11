import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminEnableUserCommand,
  AdminDisableUserCommand,
  AdminGetUserCommand
} from '@aws-sdk/client-cognito-identity-provider';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES } from 'wdr-error-codes';
import { decodeToken } from 'wdr-common-utils';

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION
});

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const defaultUserId = '00000000-0000-0000-0000-000000000000';

export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Received event:', JSON.stringify(event, null, 2));

    const userName:string = event.queryStringParameters?.userName || "";
    
    const rawToken = event.headers?.Authorization || event.headers?.authorization || "";
    const token = rawToken.startsWith("Bearer ") ? rawToken.slice(7) : rawToken;

    let currentUserId = event.requestContext?.authorizer?.claims?.sub || defaultUserId;

    if (!currentUserId && token) {
      try {
        const decodedToken: any = decodeToken(token);
        currentUserId = decodedToken?.payload?.sub || defaultUserId;
      } catch (err) {
        console.warn("Invalid token:", err);
        currentUserId = defaultUserId;
      }
    }


    if (!USER_POOL_ID) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          'Configuration error: User pool ID not configured',
          ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code
        ),
        500
      );
    }

    if (userName === "") {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          'Missing required parameter: userName',
          ERROR_CODES.INVALID_REQUEST.code
        ),
        400
      );
    }

    // Step 1: Get current state in Cognito
    let isEnabled: boolean;
    try {
      console.log(`Fetching current status for user ${userName} from Cognito...`);
      const getUserCommand = new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: userName
      });
      const userData = await cognitoClient.send(getUserCommand);

      // Cognito returns `Enabled: true/false`
      isEnabled = !!userData.Enabled;
      console.log(`User ${userName} is currently ${isEnabled ? 'ENABLED' : 'DISABLED'}`);
    } catch (cognitoError: any) {
      console.error(`Failed to fetch user ${userName} from Cognito`, cognitoError);
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          `User ${userName} not found`,
          404
        ),
        500
      );
    }

    // Step 2: Toggle status
    try {
      if (isEnabled) {
        // Disable user
        console.log(`Disabling user ${userName} in Cognito...`);
        await cognitoClient.send(
          new AdminDisableUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: userName
          })
        );

        console.log(`Updating status for ${userName} in DB to 1 (inactive)...`);
        const dbResult = await executeQuery(
          `UPDATE users SET status = 1, updated_at = NOW(), updated_by = $1 WHERE id = $2`,
          [currentUserId, userName]
        );

        if (!dbResult.success) {
          throw new Error(dbResult.error || 'Unknown DB error');
        }

        console.log(`User ${userName} disabled successfully`);
        return LambdaResponse.success(
          new ApiResponse(
            true,
            null,
            `User ${userName} deactivated successfully`,
            ERROR_CODES.SUCCESS.code
          )
        );
      } else {
        // Enable user
        console.log(`Enabling user ${userName} in Cognito...`);
        await cognitoClient.send(
          new AdminEnableUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: userName
          })
        );

        console.log(`Updating status for ${userName} in DB to 0 (active)...`);
        const dbResult = await executeQuery(
          `UPDATE users SET status = 0, updated_at = NOW(), updated_by = $1 WHERE id = $2`,
          [currentUserId, userName]
        );

        if (!dbResult.success) {
          throw new Error(dbResult.error || 'Unknown DB error');
        }

        console.log(`User ${userName} enabled successfully`);
        return LambdaResponse.success(
          new ApiResponse(
            true,
            null,
            `User ${userName} activated successfully`,
            ERROR_CODES.SUCCESS.code
          )
        );
      }
    } catch (error: any) {
      console.error(`Failed to toggle status for user ${userName}`, error);
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          `Failed to toggle user: ${error.message}`,
          ERROR_CODES.DATABASE_ERROR.code
        ),
        500
      );
    }
  } catch (error) {
    console.error('Unexpected error in handler:', error);
    return LambdaResponse.error(
      new ApiResponse(false, null, 'Unexpected error', ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code),
      500
    );
  }
};
