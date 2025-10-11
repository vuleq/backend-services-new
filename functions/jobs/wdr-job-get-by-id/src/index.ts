import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { isValidUUID, isValidCognitoSub, getLoginUserInfo } from 'wdr-common-utils';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

enum TradeMemberRoleCode {
  HOD = 'HOD',
  FOR = 'FOR',
  TS = 'TS'
}

const jobStatusName: Record<number, string> = {
  0: 'Draft',
  1: 'Confirmed',
  2: 'Cancelled',
  3: 'Started',
  4: 'Completed'
};

const wdrStatusName: Record<number, string> = {
  0: 'Not started',
  1: 'Draft',
  2: 'Pre review',
  3: 'HOD review',
  4: 'SRM review',
  5: 'Completed'
};

const jobTypeName: Record<number, string> = {
  0: 'Main',
  1: 'Support',
  2: 'AWRF'
};

interface Job {
  id: string;
  actual_start_date: string | Date;
  actual_complete_date: string | Date;
  status: number;
  wdr_status: number;
  job_type: number;
  progress?: number;
  project_id: string;
  trade_section_id?: string;
  sub_code?: string;
  trade_section?: {
    id: string;
    name: string;
  };
  assignee?: Array<{
    id: string;
    name: string;
    role: string;
  }>;
  files?: Array<{
    id: string;
    name: string;
    s3url: string;
    type: string;
  }>;
  reports?: Array<{
    id: string;
    job_title: string;
    status: number | null;
    version: number | null;
    thumbnail?: string;
    reporter_id: string;
    reporter_name: string;
    reporter_avt?: string;
  }>;
}

function calculateJobProgress(job: Job, today: Date): number {
  try {
    const planStart = new Date(job.actual_start_date);
    const planComplete = new Date(job.actual_complete_date);

    if (isNaN(planStart.getTime()) || isNaN(planComplete.getTime())) {
      return 0;
    }

    const totalPlanDays = Math.max(1, Math.ceil((planComplete.getTime() - planStart.getTime()) / MILLISECONDS_PER_DAY) + 1);
    
    let trackingDate: Date | null = null;
    if (planStart <= today) {
      trackingDate = today > planComplete ? planComplete : today;
    }
    
    const workedDays = trackingDate ? Math.ceil((trackingDate.getTime() - planStart.getTime()) / MILLISECONDS_PER_DAY) + 1 : 0;

    return workedDays > 0 ? Math.round((workedDays / totalPlanDays) * 100) : 0;
  } catch (error) {
    console.error('Error calculating job progress:', error);
    return 0;
  }
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Receive Event:', JSON.stringify(event));
  const id = event.pathParameters?.id;

  if (!id || !isValidUUID(id)) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid or missing job ID'));
  }

  try {
    // Get user information from Cognito claims
    const requestHeader = event.headers;
    const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

    if (!loginUserId || !isValidCognitoSub(loginUserId)) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid user ID format'));
    }

    // Get main job data
    const jobSql = `SELECT j.*, 
      CASE WHEN ts.id IS NOT NULL THEN json_build_object('id', ts.id, 'name', ts.name) ELSE null END as trade_section,
      CASE WHEN sb.id IS NOT NULL THEN json_build_object('id', sb.id, 'sub_no', sb.sub_no) ELSE null END as sub_code
    FROM jobs j 
    LEFT JOIN sub_codes sb ON j.sub_code = sb.id
    LEFT JOIN trade_sections ts ON ts.id = j.trade_section_id
    WHERE j.id = $1`;

    const jobResult = await executeQuery(jobSql, [id]);
    if (jobResult.error || jobResult.rowCount === 0) {
      return new LambdaResponse(400, new ApiResponse(false, null, jobResult.error || 'Job not found!'));
    }

    const job: Job = jobResult.data[0];

    const hasAccess = await isUserAllowToViewJob(loginUserId, job.project_id, job.trade_section_id);
    if (!hasAccess) {
      return new LambdaResponse(403, new ApiResponse(false, null, 'User do not has permission to view job detail'));
    }

    // Get assignees
    const assigneeSql = `SELECT u.id, u.name, ro.name as role
    FROM jobs j
    LEFT JOIN project_trade_sections pts ON pts.project_id = j.project_id AND pts.trade_section_id = j.trade_section_id
    LEFT JOIN project_trade_section_assigns ptsa ON ptsa.project_trade_section_id = pts.id
    LEFT JOIN users u ON u.id = ptsa.user_id
    LEFT JOIN roles ro ON ro.id = ptsa.role_id
    WHERE j.id = $1 AND u.id IS NOT NULL`;

    const assigneeResult = await executeQuery(assigneeSql, [id]);
    job.assignee = assigneeResult.error ? [] : assigneeResult.data;

    // Get files
    const filesSql = `SELECT id as id, file_name as name, s3_url as s3url, file_type as type FROM files WHERE job_id = $1 ORDER BY uploaded_at DESC`;
    const filesResult = await executeQuery(filesSql, [id]);
    job.files = filesResult.error ? [] : filesResult.data;

    // Get reports
    const reportsSql = `SELECT r.id, r.job_title, r.version, r.thumbnail, r.status, u.id as reporter_id, u.name as reporter_name, u.avt as reporter_avt FROM report r LEFT JOIN users u ON r.created_by = u.id WHERE r.job_id = $1`;
    const reportsResult = await executeQuery(reportsSql, [id]);
    job.reports = reportsResult.error ? [] : reportsResult.data;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const plannedProgress = calculateJobProgress(job, today);
    const actualProgress = job.progress ?? 0;

    const responseData = {
      ...job,
      status: jobStatusName[job.status] || 'Unknown',
      wdr_status: wdrStatusName[job.wdr_status] || 'Unknown',
      job_type: jobTypeName[job.job_type] || 'Unknown',
      planned_progress: plannedProgress,
      actual_progress: actualProgress
    };

    return new LambdaResponse(200, new ApiResponse(true, responseData));
  } catch (error: any) {
    console.error('Error:', JSON.stringify(error));
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error'));
  }
};

async function isUserAllowToViewJob(userId: string, projectId: string, tradeSectionId: string | undefined): Promise<boolean> {
  try {
    // All project role can view job
    const checkProjectRoleResult = await executeQuery(
      `SELECT EXISTS (SELECT 1 FROM project_assignments pa WHERE pa.user_id = $1 AND pa.project_id = $2)`,
      [userId, projectId]
    );

    if (!checkProjectRoleResult.success) {
      console.error('Failed to check project role');
      return false;
    }

    if (checkProjectRoleResult.data[0].exists) {
      return true;
    }

    // If job has trade section, check user role in trade section
    if (tradeSectionId) {
      // Only Trade Supervisor, Foreman and HOD can view job detail
      const checkTradeRoleResult = await executeQuery(
        `SELECT EXISTS (SELECT 1 FROM project_trade_sections pts 
        LEFT JOIN project_trade_section_assigns ptsa ON pts.id = ptsa.project_trade_section_id 
        LEFT JOIN roles r ON ptsa.role_id = r.id
        WHERE pts.trade_section_id = $1 AND ptsa.user_id = $2 AND r.code = ANY($3))`,
        [tradeSectionId, userId, [TradeMemberRoleCode.HOD, TradeMemberRoleCode.TS, TradeMemberRoleCode.FOR]]
      );

      if (!checkTradeRoleResult.success) {
        console.error('Failed to check trade role');
        return false;
      }

      return checkTradeRoleResult.data[0].exists;
    }

    return false;
  } catch (error) {
    console.error('Error in isUserAllowToViewJob:', JSON.stringify(error));
    return false;
  }
}
