import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { isValidUUID } from 'wdr-common-utils';
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
  COMPLETED: 2
});

// Interfaces
interface ApproverUser {
  userId: string;
  name: string;
  email: string;
}

interface NextApproverResponse {
  hasNextStep: boolean;
  nextStep?: {
    stepNumber: number;
    stepName: string;
    roleApprover: string;
    roleName: string;
    roleCode: string;
    isSignature: boolean;
    isRequired: boolean;
    historyId?: string;
    approvers: ApproverUser[];
  };
  currentStatus: string;
  allStepsCompleted: boolean;
  workflowProgress: {
    totalSteps: number;
    completedSteps: number;
    currentStepNumber?: number;
    rejectedAt?: number;
  };
  reportInfo: {
    reportId: string;
    reportStatus: number;
    workflowReportId: string;
    workflowName?: string;
  };
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Get next approver handler received event:', JSON.stringify(event, null, 2));

  try {
    // Get parameters from query string
    const reportId = event.queryStringParameters?.reportId;
    let workflowReportId = event.queryStringParameters?.workflowReportId;

    // Validate required parameters
    if (!reportId) {
      const errorResponse = new ApiResponse(false, undefined, 'Missing required parameter: reportId');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate reportId UUID
    if (!isValidUUID(reportId)) {
      const errorResponse = new ApiResponse(false, undefined, 'Invalid reportId format');
      return LambdaResponse.error(errorResponse, 400);
    }

    // If workflowReportId is not provided, get the first available workflow
    if (!workflowReportId) {
      console.log('No workflowReportId provided, getting first available workflow...');
      const firstWorkflow = await getFirstAvailableWorkflow();
      
      if (!firstWorkflow) {
        const errorResponse = new ApiResponse(false, undefined, 'No workflow found for this report');
        return LambdaResponse.error(errorResponse, 404);
      }
      
      workflowReportId = firstWorkflow;
      console.log(`Using first available workflow: ${workflowReportId}`);
    } else {
      // Validate workflowReportId UUID if provided
      if (!isValidUUID(workflowReportId)) {
        const errorResponse = new ApiResponse(false, undefined, 'Invalid workflowReportId format');
        return LambdaResponse.error(errorResponse, 400);
      }
    }

    console.log(`Getting next approver for report: ${reportId}, workflow: ${workflowReportId}`);

    const nextApprover = await getNextApprover(reportId, workflowReportId);
    
    const successResponse = new ApiResponse(true, nextApprover, 'Next approver information retrieved successfully');
    return LambdaResponse.success(successResponse, 200);

  } catch (error: unknown) {
    console.error('Get next approver error:', error);
    
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
 * Get first available workflow
 */
async function getFirstAvailableWorkflow(): Promise<string | null> {
  console.log('Getting first available workflow...');
  
  const result = await executeQuery(
    `SELECT id FROM dynamic_workflow_report 
     WHERE status = 1 
     ORDER BY created_at ASC 
     LIMIT 1`,
    []
  );

  if (!result.success || !result.data || result.data.length === 0) {
    console.log('No active workflow found');
    return null;
  }

  return result.data[0].id;
}

/**
 * Get users by role code
 */
async function getUsersByRole(roleCode: string): Promise<ApproverUser[]> {
  console.log(`Getting users for role: ${roleCode}`);
  
  const result = await executeQuery(
    `SELECT DISTINCT u.id as user_id, u.name, u.email 
     FROM users u
     INNER JOIN user_roles ur ON u.id = ur.user_id
     INNER JOIN roles r ON ur.role_id = r.id
     WHERE r.code = $1 AND u.status = 1
     ORDER BY u.name`,
    [roleCode]
  );

  if (!result.success || !result.data) {
    console.log(`No users found for role: ${roleCode}`);
    return [];
  }

  return result.data.map((row: any) => ({
    userId: row.user_id,
    name: row.name,
    email: row.email
  }));
}

/**
 * Get next step from workflow definition
 */
async function getNextWorkflowStep(workflowReportId: string, currentStepNumber?: number): Promise<any> {
  const nextStepNumber = currentStepNumber ? currentStepNumber + 1 : 1;
  
  console.log(`Getting workflow step ${nextStepNumber} for workflow: ${workflowReportId}`);
  
  const result = await executeQuery(
    `SELECT ws.step_number, ws.step_name, ws.role_approver, 
            r.name as role_name, r.code as role_code,
            ws.is_signature, ws.is_required
     FROM dynamic_workflow_steps ws
     INNER JOIN roles r ON ws.role_approver = r.id
     WHERE ws.workflow_report_id = $1 AND ws.step_number = $2
     ORDER BY ws.step_number LIMIT 1`,
    [workflowReportId, nextStepNumber]
  );

  if (!result.success || !result.data || result.data.length === 0) {
    console.log(`No workflow step found for step ${nextStepNumber}`);
    return null;
  }

  return result.data[0];
}

/**
 * Create history step entry
 */
async function createHistoryStep(reportId: string, workflowReportId: string, stepData: any): Promise<string> {
  console.log(`Creating history step for report ${reportId}, step ${stepData.step_number}`);
  
  const result = await executeQuery(
    `INSERT INTO dynamic_workflow_history_report_step 
     (report_id, workflow_report_id, step_number, step_name, role_approver, 
      role_name, role_code, is_signature, is_required, step_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      reportId,
      workflowReportId,
      stepData.step_number,
      stepData.step_name,
      stepData.role_approver,
      stepData.role_name,
      stepData.role_code,
      stepData.is_signature,
      stepData.is_required,
      stepStatus.PROCESSING
    ]
  );

  if (!result.success || !result.data || result.data.length === 0) {
    throw new Error('Failed to create history step');
  }

  return result.data[0].id;
}

/**
 * Enhanced get next approver logic
 */
async function getNextApprover(reportId: string, workflowReportId: string): Promise<NextApproverResponse> {
  console.log('Processing enhanced next approver logic...');

  // Get report information
  const reportInfoResult = await executeQuery(
    'SELECT status FROM reports WHERE id = $1',
    [reportId]
  );

  if (!reportInfoResult.success || !reportInfoResult.data || reportInfoResult.data.length === 0) {
    throw new ResourceNotFoundError('Report not found');
  }

  const reportCurrentStatus = reportInfoResult.data[0].status;

  // Get workflow information
  const workflowInfoResult = await executeQuery(
    'SELECT name FROM dynamic_workflow_report WHERE id = $1',
    [workflowReportId]
  );

  const workflowName = workflowInfoResult.success && workflowInfoResult.data?.length > 0 
    ? workflowInfoResult.data[0].name 
    : undefined;

  // Check if workflow history exists
  const historyCheckResult = await executeQuery(
    'SELECT COUNT(*) as count FROM dynamic_workflow_history_report_step WHERE report_id = $1 AND workflow_report_id = $2',
    [reportId, workflowReportId]
  );

  const hasHistory = historyCheckResult.success && 
                    historyCheckResult.data && 
                    historyCheckResult.data[0].count > 0;

  let workflowProgress: any;
  let nextStep: any = null;
  let currentStatus = 'pending';
  let allStepsCompleted = false;

  if (hasHistory) {
    console.log('Workflow history exists, checking current state...');
    
    // Get workflow progress statistics
    const progressResult = await executeQuery(
      `SELECT 
         COUNT(*) as total_steps,
         COUNT(CASE WHEN step_status = $3 THEN 1 END) as completed_steps,
         MIN(CASE WHEN step_status = $4 THEN step_number END) as rejected_at,
         MAX(CASE WHEN step_status = $5 THEN step_number END) as current_processing_step
       FROM dynamic_workflow_history_report_step 
       WHERE report_id = $1 AND workflow_report_id = $2`,
      [reportId, workflowReportId, stepStatus.APPROVED, stepStatus.REJECTED, stepStatus.PROCESSING]
    );

    if (!progressResult.success || !progressResult.data) {
      throw new ResourceNotFoundError('Workflow progress data not found');
    }

    const { total_steps, completed_steps, rejected_at, current_processing_step } = progressResult.data[0];
    allStepsCompleted = total_steps === completed_steps;

    workflowProgress = {
      totalSteps: total_steps,
      completedSteps: completed_steps,
      currentStepNumber: current_processing_step,
      rejectedAt: rejected_at
    };

    console.log(`Workflow progress: ${completed_steps}/${total_steps} steps completed`);

    // Check if there's a rejected step
    if (rejected_at !== null) {
      console.log(`Workflow rejected at step: ${rejected_at}`);
      currentStatus = 'rejected';
    } else if (allStepsCompleted) {
      console.log('All workflow steps completed');
      currentStatus = 'completed';
    } else if (current_processing_step !== null) {
      // Get current processing step details
      const currentStepResult = await executeQuery(
        `SELECT id, step_number, step_name, step_status, role_approver, role_name, role_code, is_signature, is_required
         FROM dynamic_workflow_history_report_step 
         WHERE report_id = $1 AND workflow_report_id = $2 AND step_status = $3
         ORDER BY step_number LIMIT 1`,
        [reportId, workflowReportId, stepStatus.PROCESSING]
      );

      if (currentStepResult.success && currentStepResult.data && currentStepResult.data.length > 0) {
        const currentStep = currentStepResult.data[0];
        console.log(`Current processing step: ${currentStep.step_number}`);
        
        // Get approvers for current step
        const approvers = await getUsersByRole(currentStep.role_code);
        
        if (approvers.length === 0) {
          // No users found for current role, try to move to next step
          console.log(`No approvers found for role ${currentStep.role_code}, checking next step...`);
          
          const nextWorkflowStep = await getNextWorkflowStep(workflowReportId, currentStep.step_number);
          if (nextWorkflowStep) {
            // Update current step to approved and create next step
            await executeQuery(
              'UPDATE dynamic_workflow_history_report_step SET step_status = $1 WHERE id = $2',
              [stepStatus.APPROVED, currentStep.id]
            );
            
            const historyId = await createHistoryStep(reportId, workflowReportId, nextWorkflowStep);
            const nextApprovers = await getUsersByRole(nextWorkflowStep.role_code);
            
            nextStep = {
              stepNumber: nextWorkflowStep.step_number,
              stepName: nextWorkflowStep.step_name,
              roleApprover: nextWorkflowStep.role_approver,
              roleName: nextWorkflowStep.role_name,
              roleCode: nextWorkflowStep.role_code,
              isSignature: nextWorkflowStep.is_signature,
              isRequired: nextWorkflowStep.is_required,
              historyId: historyId,
              approvers: nextApprovers
            };
            
            workflowProgress.completedSteps += 1;
            workflowProgress.currentStepNumber = nextWorkflowStep.step_number;
            currentStatus = 'processing';
          } else {
            // No more steps, workflow completed
            await executeQuery(
              'UPDATE dynamic_workflow_history_report_step SET step_status = $1 WHERE id = $2',
              [stepStatus.APPROVED, currentStep.id]
            );
            currentStatus = 'completed';
            allStepsCompleted = true;
            workflowProgress.completedSteps += 1;
          }
        } else {
          // Found approvers for current step
          nextStep = {
            stepNumber: currentStep.step_number,
            stepName: currentStep.step_name,
            roleApprover: currentStep.role_approver,
            roleName: currentStep.role_name,
            roleCode: currentStep.role_code,
            isSignature: currentStep.is_signature,
            isRequired: currentStep.is_required,
            historyId: currentStep.id,
            approvers: approvers
          };
          currentStatus = 'processing';
        }
      }
    } else {
      // Check for pending steps
      const pendingStepResult = await executeQuery(
        `SELECT step_number FROM dynamic_workflow_history_report_step 
         WHERE report_id = $1 AND workflow_report_id = $2 AND step_status = $3
         ORDER BY step_number LIMIT 1`,
        [reportId, workflowReportId, stepStatus.PENDING]
      );

      if (pendingStepResult.success && pendingStepResult.data && pendingStepResult.data.length > 0) {
        // Set first pending step to processing
        const pendingStepNumber = pendingStepResult.data[0].step_number;
        await executeQuery(
          `UPDATE dynamic_workflow_history_report_step 
           SET step_status = $1 
           WHERE report_id = $2 AND workflow_report_id = $3 AND step_number = $4`,
          [stepStatus.PROCESSING, reportId, workflowReportId, pendingStepNumber]
        );
        
        // Recursively call to get the updated state
        return await getNextApprover(reportId, workflowReportId);
      } else {
        currentStatus = 'stuck';
      }
    }
  } else {
    console.log('No workflow history found, starting from first step...');
    
    // Get first step from workflow definition
    const firstStep = await getNextWorkflowStep(workflowReportId, 0);
    
    if (!firstStep) {
      throw new ResourceNotFoundError('No workflow steps found for this workflow');
    }

    // Get total steps count for workflow
    const totalStepsResult = await executeQuery(
      'SELECT COUNT(*) as total FROM dynamic_workflow_steps WHERE workflow_report_id = $1',
      [workflowReportId]
    );

    const totalSteps = totalStepsResult.success && totalStepsResult.data 
      ? totalStepsResult.data[0].total 
      : 1;

    workflowProgress = {
      totalSteps: totalSteps,
      completedSteps: 0,
      currentStepNumber: 1
    };

    // Create history entry for first step
    const historyId = await createHistoryStep(reportId, workflowReportId, firstStep);
    
    // Get approvers for first step
    let approvers = await getUsersByRole(firstStep.role_code);
    let currentStepData = firstStep;
    let currentHistoryId = historyId;

    // If no approvers found, keep looking for next step with approvers
    while (approvers.length === 0) {
      console.log(`No approvers found for step ${currentStepData.step_number}, checking next step...`);
      
      // Mark current step as approved
      await executeQuery(
        'UPDATE dynamic_workflow_history_report_step SET step_status = $1 WHERE id = $2',
        [stepStatus.APPROVED, currentHistoryId]
      );
      
      // Get next step
      const nextWorkflowStep = await getNextWorkflowStep(workflowReportId, currentStepData.step_number);
      
      if (!nextWorkflowStep) {
        // No more steps and no approvers found - workflow completed
        console.log('No more steps and no approvers found - workflow completed');
        currentStatus = 'completed';
        allStepsCompleted = true;
        workflowProgress.completedSteps = totalSteps;
        break;
      }
      
      // Create history for next step
      currentHistoryId = await createHistoryStep(reportId, workflowReportId, nextWorkflowStep);
      approvers = await getUsersByRole(nextWorkflowStep.role_code);
      currentStepData = nextWorkflowStep;
      workflowProgress.completedSteps += 1;
      workflowProgress.currentStepNumber = nextWorkflowStep.step_number;
    }

    if (approvers.length > 0) {
      nextStep = {
        stepNumber: currentStepData.step_number,
        stepName: currentStepData.step_name,
        roleApprover: currentStepData.role_approver,
        roleName: currentStepData.role_name,
        roleCode: currentStepData.role_code,
        isSignature: currentStepData.is_signature,
        isRequired: currentStepData.is_required,
        historyId: currentHistoryId,
        approvers: approvers
      };
      currentStatus = 'processing';
    }
  }

  // Build final response
  const response: NextApproverResponse = {
    hasNextStep: nextStep !== null && !allStepsCompleted && currentStatus !== 'rejected',
    currentStatus,
    allStepsCompleted,
    workflowProgress,
    reportInfo: {
      reportId: reportId,
      reportStatus: reportCurrentStatus,
      workflowReportId: workflowReportId,
      workflowName: workflowName
    }
  };

  if (nextStep) {
    response.nextStep = nextStep;
  }

  console.log('Final response:', JSON.stringify(response, null, 2));
  return response;
}