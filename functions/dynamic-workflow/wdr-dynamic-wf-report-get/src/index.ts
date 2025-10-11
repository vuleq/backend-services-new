import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

// Custom error classes
class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

const defaultUserId = "00000000-0000-0000-0000-000000000000";
const defaultUserName = 'PaxOcean Admin';

// Interfaces
interface WorkflowStepResponse {
  id: string;
  workflowReportId: string;
  stepNumber: number;
  stepName: string;
  roleApprover: string;
  roleName: string;
  roleCode: string;
  isSignature: boolean;
  isRequired: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowInfo {
  id: string;
  name: string;
  code: string;
  roleApply: string;
  roleName: string;
  roleCode: string;
  status: number;
}

interface GetWorkflowStepsResponse {
  workflow: WorkflowInfo;
  steps: WorkflowStepResponse[];
  totalSteps: number;
}

// Database row interfaces
interface WorkflowStepRow {
  id: string;
  workflow_report_id: string;
  step_number: number;
  step_name: string;
  role_approver: string;
  role_name: string;
  role_code: string;
  is_signature: boolean;
  is_required: boolean;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
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
  console.log('Get workflow steps handler received event:', JSON.stringify(event, null, 2));

  try {
    const userInfo = getLoginUserInfo(event.headers);
    console.log('User info:', userInfo);

    // Get the first workflow from database
    const workflowQuery = await executeQuery(
      `SELECT id, name, code, role_apply, role_name, role_code, status, 
              created_by, updated_by, created_at, updated_at 
       FROM dynamic_workflow_report 
       ORDER BY created_at ASC 
       LIMIT 1`,
      []
    );

    if (!workflowQuery.success || !workflowQuery.data || workflowQuery.data.length === 0) {
      const errorResponse = new ApiResponse(false, undefined, 'No workflow found in database');
      return LambdaResponse.error(errorResponse, 404);
    }

    const workflow = workflowQuery.data[0];
    const workflowId = workflow.id;
    console.log('Found workflow ID:', workflowId);

    // Get workflow steps
    const stepsQuery = await executeQuery(
      `SELECT id, workflow_report_id, step_number, step_name, 
              role_approver, role_name, role_code, 
              is_signature, is_required,
              created_by, updated_by, created_at, updated_at
       FROM dynamic_workflow_report_step 
       WHERE workflow_report_id = $1 
       ORDER BY step_number ASC`,
      [workflowId]
    );

    if (!stepsQuery.success) {
      console.error('Failed to query workflow steps:', stepsQuery);
      const errorResponse = new ApiResponse(false, undefined, 'Failed to retrieve workflow steps');
      return LambdaResponse.error(errorResponse, 500);
    }

    // Transform data to response format
    const workflowInfo: WorkflowInfo = {
      id: workflow.id,
      name: workflow.name,
      code: workflow.code,
      roleApply: workflow.role_apply,
      roleName: workflow.role_name,
      roleCode: workflow.role_code,
      status: workflow.status
    };

    const steps: WorkflowStepResponse[] = (stepsQuery.data || []).map((step: WorkflowStepRow) => ({
      id: step.id,
      workflowReportId: step.workflow_report_id,
      stepNumber: step.step_number,
      stepName: step.step_name,
      roleApprover: step.role_approver,
      roleName: step.role_name,
      roleCode: step.role_code,
      isSignature: step.is_signature,
      isRequired: step.is_required,
      createdBy: step.created_by,
      updatedBy: step.updated_by,
      createdAt: step.created_at,
      updatedAt: step.updated_at
    }));

    const responseData: GetWorkflowStepsResponse = {
      workflow: workflowInfo,
      steps: steps,
      totalSteps: steps.length
    };

    console.log(`Retrieved ${steps.length} workflow steps for workflow ${workflowId}`);

    const successResponse = new ApiResponse(true, responseData, 'Workflow steps retrieved successfully');
    return LambdaResponse.success(successResponse, 200);

  } catch (error: unknown) {
    console.error('Get workflow steps error:', error);
    
    if (error instanceof ResourceNotFoundError) {
      const errorResponse = new ApiResponse(false, undefined, error.message);
      return LambdaResponse.error(errorResponse, 404);
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    const errorResponse = new ApiResponse(false, undefined, errorMessage);
    return LambdaResponse.error(errorResponse, 500);
  }
};