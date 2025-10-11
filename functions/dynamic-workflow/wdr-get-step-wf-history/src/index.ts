import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { executeQuery } from "wdr-connect-db";
import { ApiResponse, LambdaResponse } from "wdr-models";
import { ERROR_CODES } from "wdr-error-codes";
import { isValidUUID } from "wdr-common-utils";

type WorkflowHistoryStep = {
  id: string;
  reportId: string;
  workflowReportId: string;
  stepNumber: number;
  stepName: string;
  stepStatus: string;
  approverStatus: string;
  approver: {
    id: string | null;
    name: string | null;
    email: string | null;
  };
  isSignature: boolean;
  comment: string | null;
  roleApprover: string;
  roleName: string;
  roleCode: string;
  actionTakenAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
};

// Status mappings
const stepStatusMap: Record<number, string> = {
  0: 'pending',
  1: 'approved',
  2: 'rejected',
  3: 'processing'
};

const approverStatusMap: Record<number, string> = {
  0: 'pending',
  1: 'approved',
  2: 'rejected'
};

export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log("=== Get Workflow History Steps API Called ===");
    console.log("Event:", event);

    // Get report ID from query parameters
    const queryParams = event.queryStringParameters ?? {};
    const reportId = queryParams.reportId;
    
    if (!reportId) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          "Report ID is required",
          ERROR_CODES.VALIDATION_ERROR.code
        ),
        400
      );
    }

    // Validate UUID format
    if (!isValidUUID(reportId)) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          "Invalid report ID format",
          ERROR_CODES.VALIDATION_ERROR.code
        ),
        400
      );
    }

    console.log("Getting workflow history for report:", reportId);

    // Query to get workflow history steps with approver information
    const sql = `
      SELECT 
        h.id,
        h.report_id,
        h.workflow_report_id,
        h.step_number,
        h.step_name,
        h.step_status,
        h.approver_status,
        h.approver_id,
        h.is_signature,
        h.comment,
        h.role_approver,
        h.role_name,
        h.role_code,
        h.action_taken_at,
        h.created_at,
        h.updated_at,
        h.created_by,
        h.updated_by,
        u.name as approver_name,
        u.email as approver_email
      FROM dynamic_workflow_history_report_step h
      LEFT JOIN users u ON h.approver_id = u.id
      WHERE h.report_id = $1
      ORDER BY h.step_number ASC
    `;

    console.log("Executing SQL:", sql);
    console.log("Parameters:", [reportId]);

    const result = await executeQuery(sql, [reportId]);

    if (!result || result.success === false) {
      console.error("Database query failed:", result?.error);
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          result?.error || "Failed to retrieve workflow history",
          ERROR_CODES.DATABASE_ERROR.code
        ),
        500
      );
    }

    console.log("Query result:", result.data);

    // Check if workflow history exists for this report
    if (!result.data || result.data.length === 0) {
      return LambdaResponse.success(
        new ApiResponse(
          true,
          [],
          "No workflow history found for this report",
          ERROR_CODES.SUCCESS.code
        )
      );
    }

    // Transform the data
    const historySteps: WorkflowHistoryStep[] = result.data.map((row: any) => ({
      id: row.id,
      reportId: row.report_id,
      workflowReportId: row.workflow_report_id,
      stepNumber: row.step_number,
      stepName: row.step_name,
      stepStatus: stepStatusMap[row.step_status] || 'unknown',
      approverStatus: approverStatusMap[row.approver_status] || 'unknown',
      approver: {
        id: row.approver_id,
        name: row.approver_name,
        email: row.approver_email
      },
      isSignature: row.is_signature,
      comment: row.comment,
      roleApprover: row.role_approver,
      roleName: row.role_name,
      roleCode: row.role_code,
      actionTakenAt: row.action_taken_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      updatedBy: row.updated_by
    }));

    console.log("Transformed history steps:", historySteps.length);

    return LambdaResponse.success(
      new ApiResponse(
        true,
        historySteps,
        "Workflow history retrieved successfully",
        ERROR_CODES.SUCCESS.code
      )
    );

  } catch (error: any) {
    console.error("Unhandled Error:", error);
    return LambdaResponse.error(
      new ApiResponse(
        false,
        null,
        "An unexpected error occurred while retrieving workflow history",
        ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code
      ),
      500
    );
  }
};