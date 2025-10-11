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

class BusinessLogicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessLogicError';
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

const reportType = Object.freeze({
  TEMPLATE: 0,
  HEADER: 1,
  FOOTER: 2,
  REPORT: 3,
  COVER: 4
});

const reportStatus = Object.freeze({
  DRAFT: 0,
  IN_REVIEW: 1,
  REJECTED: 2,
  COMPLETED: 3
});

// Interfaces
interface SubmitReportRequest {
  reportId: string;
  workflowReportId?: string | null; // Made optional and nullable
  approverId: string; // Current step approver ID
  step: number; // Current processing step number
}

interface SubmitReportResponse {
  reportId: string;
  workflowReportId: string;
  stepsCreated: number;
  currentStep: number;
  reportStatus: string;
  currentApproverId: string; // Current approver ID
  steps: Array<{
    id: string;
    stepNumber: number;
    stepName: string;
    status: string;
    roleName: string;
    roleCode: string;
    approverId?: string; // Optional approver ID for steps
  }>;
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
  console.log('Submit report handler received event:', JSON.stringify(event, null, 2));

  try {
    const userInfo = getLoginUserInfo(event.headers);
    console.log('User info:', userInfo);

    if (!event.body) {
      const errorResponse = new ApiResponse(false, undefined, 'Request body is required');
      return LambdaResponse.error(errorResponse, 400);
    }

    const requestData: SubmitReportRequest = JSON.parse(event.body);
    
    // Validate required fields (workflowReportId is now optional)
    if (!requestData.reportId || !requestData.approverId || !requestData.step) {
      const errorResponse = new ApiResponse(false, undefined, 'Missing required fields: reportId, approverId, step');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate step number
    if (!Number.isInteger(requestData.step) || requestData.step < 1) {
      const errorResponse = new ApiResponse(false, undefined, 'Step must be a positive integer');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate UUIDs (skip workflowReportId if null)
    if (!isValidUUID(requestData.reportId) || !isValidUUID(requestData.approverId)) {
      const errorResponse = new ApiResponse(false, undefined, 'Invalid ID format');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Validate workflowReportId if provided
    if (requestData.workflowReportId && !isValidUUID(requestData.workflowReportId)) {
      const errorResponse = new ApiResponse(false, undefined, 'Invalid workflowReportId format');
      return LambdaResponse.error(errorResponse, 400);
    }

    console.log(`Processing submit report: ${requestData.reportId} with workflow: ${requestData.workflowReportId || 'auto-select'}, approver: ${requestData.approverId}, current step: ${requestData.step}`);

    // Verify report exists and is of type REPORT - select all needed fields
    const reportCheck = await executeQuery(
      `SELECT 
         id, name, type, is_default, content, version, parent, project_id, job_id, 
         created_at, created_by, updated_by, updated_at, status, awrf_no, sub_code, 
         approver_id, is_published, thumbnail, trade_section, template_id, document_no, 
         job_title, header_id, footer_id, footer_content, header_content, user_lock_id, end_time
       FROM reports WHERE id = $1 AND type = $2`,
      [requestData.reportId, reportType.REPORT]
    );

    if (!reportCheck.success || !reportCheck.data || reportCheck.data.length === 0) {
      const errorResponse = new ApiResponse(false, undefined, 'Report not found or invalid type');
      return LambdaResponse.error(errorResponse, 404);
    }

    const reportData = reportCheck.data[0];
    console.log('Report found:', reportData);

    // Check if report is already completed or rejected
    if (reportData.status === reportStatus.COMPLETED) {
      const errorResponse = new ApiResponse(false, undefined, 'Report is already completed');
      return LambdaResponse.error(errorResponse, 400);
    }

    if (reportData.status === reportStatus.REJECTED) {
      const errorResponse = new ApiResponse(false, undefined, 'Report is rejected and cannot be resubmitted');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Handle workflow selection
    let workflowReportId = requestData.workflowReportId;
    let workflowData;

    if (workflowReportId) {
      // Use specific workflow if provided
      const workflowCheck = await executeQuery(
        'SELECT id, name, code FROM dynamic_workflow_report WHERE id = $1 AND status = $2',
        [workflowReportId, workflowStatus.ACTIVE]
      );

      if (!workflowCheck.success || !workflowCheck.data || workflowCheck.data.length === 0) {
        const errorResponse = new ApiResponse(false, undefined, 'Workflow not found or not active');
        return LambdaResponse.error(errorResponse, 404);
      }

      workflowData = workflowCheck.data[0];
      console.log('Specific workflow found:', workflowData);
    } else {
      // Auto-select first active workflow
      const workflowCheck = await executeQuery(
        'SELECT id, name, code FROM dynamic_workflow_report WHERE status = $1 ORDER BY created_at ASC LIMIT 1',
        [workflowStatus.ACTIVE]
      );

      if (!workflowCheck.success || !workflowCheck.data || workflowCheck.data.length === 0) {
        const errorResponse = new ApiResponse(false, undefined, 'No active workflow found');
        return LambdaResponse.error(errorResponse, 404);
      }

      workflowData = workflowCheck.data[0];
      workflowReportId = workflowData.id;
      console.log('Auto-selected workflow:', workflowData);
    }

    // Verify current step approver exists
    const approverCheck = await executeQuery(
      'SELECT id, name FROM users WHERE id = $1',
      [requestData.approverId]
    );

    if (!approverCheck.success || !approverCheck.data || approverCheck.data.length === 0) {
      const errorResponse = new ApiResponse(false, undefined, 'Current step approver not found');
      return LambdaResponse.error(errorResponse, 404);
    }

    const approverData = approverCheck.data[0];
    console.log('Current step approver found:', approverData);

    // Check if workflow history already exists for this report
    const existingHistory = await executeQuery(
      'SELECT id FROM dynamic_workflow_history_report_step WHERE report_id = $1 AND workflow_report_id = $2',
      [requestData.reportId, workflowReportId]
    );

    if (existingHistory.success && existingHistory.data && existingHistory.data.length > 0) {
      const errorResponse = new ApiResponse(false, undefined, 'Workflow already initiated for this report');
      return LambdaResponse.error(errorResponse, 400);
    }

    // Get all workflow steps
    const stepsResult = await executeQuery(
      `SELECT step_number, step_name, role_approver, role_name, role_code, is_signature, is_required
       FROM dynamic_workflow_report_step 
       WHERE workflow_report_id = $1 
       ORDER BY step_number`,
      [workflowReportId]
    );

    if (!stepsResult.success || !stepsResult.data || stepsResult.data.length === 0) {
      const errorResponse = new ApiResponse(false, undefined, 'No workflow steps found');
      return LambdaResponse.error(errorResponse, 404);
    }

    console.log(`Found ${stepsResult.data.length} workflow steps`);

    // Validate that the requested step exists
    const maxStepNumber = Math.max(...stepsResult.data.map((step: any) => step.step_number));
    if (requestData.step > maxStepNumber) {
      const errorResponse = new ApiResponse(false, undefined, `Step ${requestData.step} does not exist. Maximum step is ${maxStepNumber}`);
      return LambdaResponse.error(errorResponse, 400);
    }

    // Determine current approver ID for the processing step
    const currentApproverId = requestData.approverId;

    // Update report status to IN_REVIEW and set current approver
    const updateReportResult = await updateRecord(
      'reports',
      {
        status: reportStatus.IN_REVIEW,
        approver_id: currentApproverId, // Set current approver
        updated_by: userInfo.userId,
        updated_at: new Date().toISOString()
      },
      { id: requestData.reportId }
    );

    if (!updateReportResult.success) {
      const errorMessage = 'error' in updateReportResult ? updateReportResult.error : 'Unknown error';
      throw new Error(`Failed to update report status: ${errorMessage}`);
    }

    console.log(`Report status updated to IN_REVIEW with approver: ${currentApproverId}`);

    // Create history records for all steps
    const createdSteps = [];
    const currentStep = requestData.step;
    
    for (const step of stepsResult.data) {
      const stepNumber = step.step_number;
      let currentStepStatus: number;
      let currentApproverStatus: number;
      let approverId: string | null = null;
      let actionTakenAt: string | null = null;

      // Determine step status and approver based on current processing step
      if (stepNumber < currentStep) {
        // Previous steps are marked as approved
        currentStepStatus = stepStatus.APPROVED;
        currentApproverStatus = approverStatus.APPROVED;
        actionTakenAt = new Date().toISOString();
        // Previous steps don't need approver assignment for this submit
        approverId = null;
      } else if (stepNumber === currentStep) {
        // Current step is processing
        currentStepStatus = stepStatus.PROCESSING;
        currentApproverStatus = approverStatus.PENDING;
        actionTakenAt = new Date().toISOString();
        // Assign the provided approver to current step
        approverId = requestData.approverId;
      } else {
        // Future steps are pending
        currentStepStatus = stepStatus.PENDING;
        currentApproverStatus = approverStatus.PENDING;
        actionTakenAt = null;
      }
      
      const historyRecord = {
        report_id: requestData.reportId,
        workflow_report_id: workflowReportId, // Use the resolved workflowReportId
        approver_id: approverId,
        approver_status: currentApproverStatus,
        step_number: stepNumber,
        step_name: step.step_name,
        step_status: currentStepStatus,
        is_signature: step.is_signature,
        comment: stepNumber < currentStep ? 'Auto-approved by system' : null,
        role_approver: step.role_approver,
        role_name: step.role_name,
        role_code: step.role_code,
        action_taken_at: actionTakenAt,
        created_by: userInfo.userId,
        updated_by: userInfo.userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const insertResult = await insertRecord('dynamic_workflow_history_report_step', historyRecord);
      
      if (!insertResult.success) {
        const errorMessage = 'error' in insertResult ? insertResult.error : 'Unknown error';
        throw new Error(`Failed to create workflow history for step ${stepNumber}: ${errorMessage}`);
      }

      const historyId = 'data' in insertResult ? insertResult.data?.[0]?.id : undefined;
      
      // Convert status to string for response
      let statusString: string;
      if (stepNumber < currentStep) {
        statusString = 'approved';
      } else if (stepNumber === currentStep) {
        statusString = 'processing';
      } else {
        statusString = 'pending';
      }
      
      createdSteps.push({
        id: historyId || 'unknown',
        stepNumber: stepNumber,
        stepName: step.step_name,
        status: statusString,
        roleName: step.role_name,
        roleCode: step.role_code,
        approverId: approverId || undefined
      });

      console.log(`Workflow step ${stepNumber} history created: ${historyId} with status: ${statusString}${approverId ? ' and approver: ' + approverId : ''}`);
    }

    console.log(`All ${createdSteps.length} workflow step histories created successfully`);

    const responseData: SubmitReportResponse = {
      reportId: requestData.reportId,
      workflowReportId: workflowReportId!, // Now guaranteed to be non-null
      stepsCreated: createdSteps.length,
      currentStep: requestData.step,
      reportStatus: 'in_review',
      currentApproverId: requestData.approverId, // Current approver ID
      steps: createdSteps
    };

    const successResponse = new ApiResponse(true, responseData, 'Report submitted for workflow approval successfully');
    return LambdaResponse.success(successResponse, 201);

  } catch (error: unknown) {
    console.error('Submit report error:', error);
    
    if (error instanceof ValidationError) {
      const errorResponse = new ApiResponse(false, undefined, error.message);
      return LambdaResponse.error(errorResponse, 400);
    } else if (error instanceof ResourceNotFoundError) {
      const errorResponse = new ApiResponse(false, undefined, error.message);
      return LambdaResponse.error(errorResponse, 404);
    } else if (error instanceof BusinessLogicError) {
      const errorResponse = new ApiResponse(false, undefined, error.message);
      return LambdaResponse.error(errorResponse, 409);
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    const errorResponse = new ApiResponse(false, undefined, errorMessage);
    return LambdaResponse.error(errorResponse, 500);
  }
};