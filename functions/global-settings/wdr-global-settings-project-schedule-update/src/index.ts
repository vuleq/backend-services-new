import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SchedulerClient, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { buildError } from 'wdr-error-codes';

const scheduler = new SchedulerClient({ region: process.env.AWS_REGION });

const SYNC_TIME_CODE = 'SYNC_TIME';

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { runTime } = JSON.parse(event.body || '{}');

    // cron expressions ranges from 0 to 23
    if (typeof runTime !== 'number' || Number(runTime) < 0 || Number(runTime) > 23) {
      return new LambdaResponse(400, buildError('ENTITY_VALIDATION_FAILED', 'Run time not valid'));
    }

    const currentRuntimeResult = await executeQuery(`SELECT value FROM app_settings where code = $1`, [SYNC_TIME_CODE]);
    if (!currentRuntimeResult.success){
      return new LambdaResponse(400, buildError('DATABASE_ERROR', 'Error when get current sync runtime'));
    }

    const currentRuntime = currentRuntimeResult.data[0]?.value;
    if (Number(currentRuntime) === runTime) {
      return new LambdaResponse(200, new ApiResponse(true, null, 'Change sync runtime success'));
    }

    // Save to database
    const saveResult = await executeQuery(
      'UPDATE app_settings SET value = $1 WHERE code = $2',
      [runTime, SYNC_TIME_CODE]
    );

    if (!saveResult.success) {
      return new LambdaResponse(400, buildError('DATABASE_ERROR', 'Error when save new sync runtime'));
    }

    const scheduleExpression = `cron(0 ${runTime} ? * * *)`;

    // Update EventBridge Schedule
    await scheduler.send(new UpdateScheduleCommand({
      Name: process.env.SCHEDULE_NAME,
      ScheduleExpression: scheduleExpression,
      Target: {
        Arn: process.env.TARGET_FUNCTION_ARN,
        RoleArn: process.env.SCHEDULE_ROLE_ARN
      },
      FlexibleTimeWindow: {
        Mode: 'OFF'
      }
    }));

    return new LambdaResponse(200, new ApiResponse(true, null, 'Change sync runtime success'));
  } catch (err: any) {
    console.log('Error when change sync runtime: ', JSON.stringify(err));
    return new LambdaResponse(400, buildError('LAMBDA_SERVICE_EXCEPTION', 'Change sync runtime failed'));
  }
};