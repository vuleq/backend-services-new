import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventHeaders } from 'aws-lambda';
import { executeQuery, updateRecord } from 'wdr-connect-db';
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

class BusinessLogicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessLogicError';
  }
}

const defaultUserId = "00000000-0000-0000-0000-000000000000";
const defaultUserName = 'PaxOcean Admin';

// Status enums
const approverStatus = Object.freeze({
  PENDING: 0,
  APPROVED: 1,
  REJECTED: 2
});

const stepStatus = Object.freeze({
  PENDING: 0,
  APPROVED: 1,
  REJECTED: 2,
  PROCESSING: 3
});

const reportStatus = Object.freeze({
  DRAFT: 0,
  IN_REVIEW: 1,
  REJECTED: 2,
  COMPLETED: 3
});

// Interfaces
interface ApprovalRequest {
  reportId: string;
  workflowReportId: string;
  nextStep?: number;
  nextApproverId?: string;
  comment?: string;
  isSignature?: boolean;
}

interface ApprovalResponse {
  success: boolean;
  message: string;
  reportId: string;
  workflowReportId: string;
  stepApproved: {
    stepNumber: number;
    stepName: string;
    approvedBy: string;
    approvedAt: string;
    comment?: string;
  };
  nextStep?: {
    stepNumber: number;
    stepName: string;
    approverId: string;
    status: string;
  };
  workflowCompleted: boolean;
  reportStatus: string;
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
  console.log('Approve workflow handler received event:', JSON.stringify(event, null, 2));

  try {
    const userInfo = getLoginUserInfo(event.headers);
    console.log('User info:', userInfo);

    if (!event.body) {
      const errorResponse = new ApiResponse(false, undefined, 'Request body is required');
      return LambdaResponse.error(errorResponse, 400);
    }

    const requestData: ApprovalRequest = JSON.parse(event.body);
    
    // Validate required fields
    if (!requestData.reportId || !requestData.workflowReportId) {
      const errorResponse = new ApiResponse(false, undefined, 'Missing required fields: reportId, workflowReportId');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate UUIDs
    if (!isValidUUID(requestData.reportId) || !isValidUUID(requestData.workflowReportId)) {
      const errorResponse = new ApiResponse(false, undefined, 'Invalid ID format');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate nextStep and nextApproverId - both must be present or both must be absent
    if ((requestData.nextStep && !requestData.nextApproverId) || (!requestData.nextStep && requestData.nextApproverId)) {
      const errorResponse = new ApiResponse(false, undefined, 'nextStep and nextApproverId must both be provided together or both omitted');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate nextStep number if provided
    if (requestData.nextStep && (!Number.isInteger(requestData.nextStep) || requestData.nextStep < 1)) {
      const errorResponse = new ApiResponse(false, undefined, 'Invalid nextStep number');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate nextApproverId UUID if provided
    if (requestData.nextApproverId && !isValidUUID(requestData.nextApproverId)) {
      const errorResponse = new ApiResponse(false, undefined, 'Invalid nextApproverId format');
      return LambdaResponse.error(errorResponse, 400);
    }

    console.log(`Processing approval for report: ${requestData.reportId}, workflow: ${requestData.workflowReportId}${requestData.nextStep ? ', next step: ' + requestData.nextStep : ''}`);

    const result = await processApproval(requestData, userInfo);
    
    const successResponse = new ApiResponse(true, result, 'Workflow step approved successfully');
    return LambdaResponse.success(successResponse, 200);

  } catch (error: unknown) {
    console.error('Approve workflow error:', error);
    return handleApprovalError(error);
  }
};

/**
 * Process approval logic
 */
async function processApproval(
  requestData: ApprovalRequest,
  userInfo: { userId: string; userName: string }
): Promise<ApprovalResponse> {
  
  // Check if workflow history exists for this report
  const historyCheck = await executeQuery(
    `SELECT COUNT(*) as count 
     FROM dynamic_workflow_history_report_step 
     WHERE report_id = $1 AND workflow_report_id = $2`,
    [requestData.reportId, requestData.workflowReportId]
  );

  if (!historyCheck.success || !historyCheck.data || historyCheck.data[0].count === 0) {
    throw new ResourceNotFoundError('Workflow history not found for this report');
  }

  console.log('Workflow history found for report');

  // Get current processing step
  const currentStepResult = await executeQuery(
    `SELECT id, step_number, step_name, step_status, approver_id, role_name, role_code, is_signature, is_required 
     FROM dynamic_workflow_history_report_step 
     WHERE report_id = $1 AND workflow_report_id = $2 AND step_status = $3
     ORDER BY step_number`,
    [requestData.reportId, requestData.workflowReportId, stepStatus.PROCESSING]
  );

  if (!currentStepResult.success || !currentStepResult.data || currentStepResult.data.length === 0) {
    throw new ResourceNotFoundError('No processing step found in workflow');
  }

  if (currentStepResult.data.length > 1) {
    throw new BusinessLogicError('Multiple processing steps found - workflow is in inconsistent state');
  }

  const currentStep = currentStepResult.data[0];
  console.log('Current processing step found:', currentStep);

  // Validate current user can approve this step
  if (!currentStep.approver_id) {
    throw new BusinessLogicError(`Step ${currentStep.step_number} has no assigned approver`);
  }
  
  if (currentStep.approver_id !== userInfo.userId) {
    throw new BusinessLogicError(`Step ${currentStep.step_number} is assigned to another approver. Current user: ${userInfo.userId}, Assigned approver: ${currentStep.approver_id}`);
  }

  const approvalTimestamp = new Date().toISOString();

  // Approve current step
  const updateCurrentStepResult = await updateRecord(
    'dynamic_workflow_history_report_step',
    {
      approver_id: userInfo.userId,
      approver_status: approverStatus.APPROVED,
      step_status: stepStatus.APPROVED,
      comment: requestData.comment || null,
      is_signature: requestData.isSignature ?? currentStep.is_signature,
      action_taken_at: approvalTimestamp,
      updated_by: userInfo.userId,
      updated_at: approvalTimestamp
    },
    { id: currentStep.id }
  );

  if (!updateCurrentStepResult.success) {
    const errorMessage = 'error' in updateCurrentStepResult ? updateCurrentStepResult.error : 'Unknown error';
    throw new Error(`Failed to approve current step: ${errorMessage}`);
  }

  console.log(`Step ${currentStep.step_number} approved successfully`);

  let workflowCompleted = false;
  let reportFinalStatus = 'in_review';
  let nextStepInfo: any = undefined;

  // Handle next step logic
  if (requestData.nextStep && requestData.nextApproverId) {
    // Validate that next step exists and is pending
    const nextStepResult = await executeQuery(
      `SELECT id, step_number, step_name, step_status, role_name, role_code, is_signature, is_required
       FROM dynamic_workflow_history_report_step 
       WHERE report_id = $1 AND workflow_report_id = $2 AND step_number = $3`,
      [requestData.reportId, requestData.workflowReportId, requestData.nextStep]
    );

    if (!nextStepResult.success || !nextStepResult.data || nextStepResult.data.length === 0) {
      throw new ResourceNotFoundError(`Next step ${requestData.nextStep} not found in workflow`);
    }

    const nextStep = nextStepResult.data[0];

    if (nextStep.step_status !== stepStatus.PENDING) {
      throw new BusinessLogicError(`Next step ${requestData.nextStep} is not in pending status`);
    }

    // Validate next approver exists
    const approverCheck = await executeQuery(
      'SELECT id, name FROM users WHERE id = $1',
      [requestData.nextApproverId]
    );

    if (!approverCheck.success || !approverCheck.data || approverCheck.data.length === 0) {
      throw new ResourceNotFoundError('Next approver not found');
    }

    console.log('Next approver validated:', approverCheck.data[0]);

    // Update next step to processing with assigned approver
    const updateNextStepResult = await updateRecord(
      'dynamic_workflow_history_report_step',
      {
        step_status: stepStatus.PROCESSING,
        approver_id: requestData.nextApproverId,
        action_taken_at: approvalTimestamp,
        updated_by: userInfo.userId,
        updated_at: approvalTimestamp
      },
      { id: nextStep.id }
    );

    if (!updateNextStepResult.success) {
      console.warn('Failed to update next step status, but current approval was successful');
    } else {
      console.log(`Next step ${nextStep.step_number} set to processing with approver: ${requestData.nextApproverId}`);
    }

    // Update report's current approver
    const updateReportApproverResult = await updateRecord(
      'reports',
      {
        approver_id: requestData.nextApproverId,
        updated_by: userInfo.userId,
        updated_at: approvalTimestamp
      },
      { id: requestData.reportId }
    );

    if (!updateReportApproverResult.success) {
      console.warn('Failed to update report approver, but workflow progression was successful');
    } else {
      console.log(`Report approver updated to: ${requestData.nextApproverId}`);
    }

    nextStepInfo = {
      stepNumber: nextStep.step_number,
      stepName: nextStep.step_name,
      approverId: requestData.nextApproverId,
      status: 'processing'
    };

  } else {
    // No next step provided - check if all steps are completed
    const remainingStepsResult = await executeQuery(
      `SELECT COUNT(*) as count 
       FROM dynamic_workflow_history_report_step 
       WHERE report_id = $1 AND workflow_report_id = $2 AND step_status IN ($3, $4)`,
      [requestData.reportId, requestData.workflowReportId, stepStatus.PENDING, stepStatus.PROCESSING]
    );

    if (remainingStepsResult.success && remainingStepsResult.data && remainingStepsResult.data[0].count === 0) {
      // All steps completed - finalize workflow
      workflowCompleted = true;
      reportFinalStatus = 'completed';

      console.log('All workflow steps completed, updating report status to completed');

      const finalReportUpdateResult = await updateRecord(
        'reports',
        {
          status: reportStatus.COMPLETED,
          approver_id: userInfo.userId, // Final approver
          updated_by: userInfo.userId,
          updated_at: approvalTimestamp
        },
        { id: requestData.reportId }
      );

      if (!finalReportUpdateResult.success) {
        console.warn('Failed to update report final status, but workflow completion was recorded');
      } else {
        console.log('Report status updated to COMPLETED');
      }
    } else {
      throw new BusinessLogicError('Cannot complete workflow - there are remaining pending steps. Please specify nextStep and nextApproverId.');
    }
  }

  return {
    success: true,
    message: `Step ${currentStep.step_number} approved successfully`,
    reportId: requestData.reportId,
    workflowReportId: requestData.workflowReportId,
    stepApproved: {
      stepNumber: currentStep.step_number,
      stepName: currentStep.step_name,
      approvedBy: userInfo.userId,
      approvedAt: approvalTimestamp,
      comment: requestData.comment
    },
    nextStep: nextStepInfo,
    workflowCompleted: workflowCompleted,
    reportStatus: reportFinalStatus
  };
}

/**
 * Handle approval errors
 */
function handleApprovalError(error: unknown): APIGatewayProxyResult {
  if (error instanceof ValidationError) {
    const errorResponse = new ApiResponse(false, undefined, error.message);
    return LambdaResponse.error(errorResponse, 400);
  } else if (error instanceof ResourceNotFoundError) {
    const errorResponse = new ApiResponse(false, undefined, error.message);
    return LambdaResponse.error(errorResponse, 404);
  } else if (error instanceof BusinessLogicError) {
    const errorResponse = new ApiResponse(false, undefined, error.message);
    return LambdaResponse.error(errorResponse, 409);
  } else {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    const errorResponse = new ApiResponse(false, undefined, errorMessage);
    return LambdaResponse.error(errorResponse, 500);
  }
}