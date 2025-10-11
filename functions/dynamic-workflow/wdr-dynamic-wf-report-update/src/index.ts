import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { executeQuery, insertRecord, updateRecord } from 'wdr-connect-db';
import { isValidUUID, isValidCognitoSub } from 'wdr-common-utils';
import { ApiResponse, LambdaResponse } from 'wdr-models';

// Custom error classes
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

const defaultUserId = "00000000-0000-0000-0000-000000000000";
const defaultUserName = 'PaxOcean Admin';

// Status enums
const workflowStatus = Object.freeze({
  DRAFT: 0,
  ACTIVE: 1,
  INACTIVE: 2
});

// Interfaces
interface WorkflowStepRequest {
  stepNumber: number;
  stepName: string;
  roleApprover: string;
  roleName: string;
  roleCode: string;
  isSignature?: boolean;
  isRequired?: boolean;
}

interface WorkflowUpdateRequest {
  steps: WorkflowStepRequest[];
}

function getLoginUserInfo(requestHeader: APIGatewayProxyEventHeaders | undefined) {
  let userId = defaultUserId;
  let userName = defaultUserName;

  if (requestHeader) {
    let token = requestHeader["Authorization"] || requestHeader["authorization"];
    if (token) {
      token = token.replace('Bearer ', '');
      const payload = parseJWT(token);
      console.log('JWT token processed successfully');
      userId = payload?.sub;
      userName = payload?.name;
    }
  }
  return { userId, userName };
}

function parseJWT(token: string) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    const payload = parts[1];
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (error) {
    console.error('JWT parse error occurred');
    return null;
  }
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Update workflow handler received event:', JSON.stringify(event, null, 2));

  try {
    const userInfo = getLoginUserInfo(event.headers);
    console.log('User info:', userInfo);

    if (!event.body) {
      const errorResponse = new ApiResponse(false, undefined, 'Request body is required');
      return LambdaResponse.error(errorResponse, 400);
    }

    const requestData: WorkflowUpdateRequest = JSON.parse(event.body);
    
    // Validate steps
    if (!requestData.steps || requestData.steps.length === 0) {
      const errorResponse = new ApiResponse(false, undefined, 'At least one workflow step is required');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate step numbers are sequential
    const sortedSteps = requestData.steps.sort((a, b) => a.stepNumber - b.stepNumber);
    for (let i = 0; i < sortedSteps.length; i++) {
      if (sortedSteps[i].stepNumber !== i + 1) {
        const errorResponse = new ApiResponse(false, undefined, 'Step numbers must be sequential starting from 1');
        return LambdaResponse.error(errorResponse, 400);
      }
    }

    // Validate each step's required fields
    for (const step of requestData.steps) {
      if (!step.stepName || !step.stepName.trim()) {
        const errorResponse = new ApiResponse(false, undefined, `Step name is required for step ${step.stepNumber}`);
        return LambdaResponse.error(errorResponse, 400);
      }
      
      if (!isValidUUID(step.roleApprover)) {
        const errorResponse = new ApiResponse(false, undefined, `Invalid roleApprover format in step ${step.stepNumber}`);
        return LambdaResponse.error(errorResponse, 400);
      }
    }

    // Get the first workflow from database
    const workflowQuery = await executeQuery(
      'SELECT id FROM dynamic_workflow_report ORDER BY created_at ASC LIMIT 1',
      []
    );

    if (!workflowQuery.success || !workflowQuery.data || workflowQuery.data.length === 0) {
      const errorResponse = new ApiResponse(false, undefined, 'No workflow found in database');
      return LambdaResponse.error(errorResponse, 404);
    }

    const workflowId = workflowQuery.data[0].id;
    console.log('Found workflow ID:', workflowId);

    // Update workflow steps
    await updateWorkflowSteps(workflowId, requestData.steps, userInfo);
    
    const successResponse = new ApiResponse(true, { id: workflowId }, 'Workflow steps updated successfully');
    return LambdaResponse.success(successResponse, 200);

  } catch (error: unknown) {
    console.error('Update workflow error:', error);
    
    if (error instanceof ValidationError) {
      const errorResponse = new ApiResponse(false, undefined, error.message);
      return LambdaResponse.error(errorResponse, 400);
    } else if (error instanceof ResourceNotFoundError) {
      const errorResponse = new ApiResponse(false, undefined, error.message);
      return LambdaResponse.error(errorResponse, 404);
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    const errorResponse = new ApiResponse(false, undefined, errorMessage);
    return LambdaResponse.error(errorResponse, 500);
  }
};

/**
 * Insert workflow steps
 */
async function insertWorkflowSteps(
  workflowId: string,
  steps: WorkflowStepRequest[],
  userInfo: { userId: string; userName: string }
): Promise<void> {
  console.log(`Inserting ${steps.length} workflow steps for workflow ${workflowId}`);

  for (const step of steps) {
    const stepRecord = {
      workflow_report_id: workflowId,
      step_number: step.stepNumber,
      step_name: step.stepName.trim(),
      role_approver: step.roleApprover,
      role_name: step.roleName,
      role_code: step.roleCode,
      is_signature: step.isSignature ?? false,
      is_required: step.isRequired ?? true,
      created_by: userInfo.userId,
      updated_by: userInfo.userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const stepResult = await insertRecord('dynamic_workflow_report_step', stepRecord);
    
    if (!stepResult.success) {
      const errorMessage = 'error' in stepResult ? stepResult.error : 'Unknown error';
      throw new Error(`Failed to create workflow step ${step.stepNumber}: ${errorMessage}`);
    }

    console.log(`Workflow step ${step.stepNumber} inserted successfully`);
  }
}

/**
 * Update workflow steps using simple approach: delete all and recreate
 */
async function updateWorkflowSteps(
  workflowId: string,
  steps: WorkflowStepRequest[],
  userInfo: { userId: string; userName: string }
): Promise<void> {
  console.log(`Updating workflow steps for workflow ${workflowId}`);

  // Verify workflow exists
  const workflowExists = await executeQuery(
    'SELECT id FROM dynamic_workflow_report WHERE id = $1',
    [workflowId]
  );

  if (!workflowExists.success || !workflowExists.data || workflowExists.data.length === 0) {
    throw new ResourceNotFoundError('Workflow not found');
  }

  // Step 1: Delete all existing steps
  const deleteResult = await executeQuery(
    'DELETE FROM dynamic_workflow_report_step WHERE workflow_report_id = $1',
    [workflowId]
  );

  if (!deleteResult.success) {
    throw new Error('Failed to delete existing workflow steps');
  }

  console.log('All existing workflow steps deleted successfully');

  // Step 2: Insert new steps
  await insertWorkflowSteps(workflowId, steps, userInfo);

  console.log('All new workflow steps inserted successfully');
}