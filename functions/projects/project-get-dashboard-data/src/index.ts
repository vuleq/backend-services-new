import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

interface StatusCount {
  status: string;
  count: number;
}

interface TradeSection {
  id: string;
  name: string;
  total_job: number;
  actual_progress: number;
  planned_progress: number;
  wdrs_drafted: number;
  wdrs_completed: number;
  status_count: StatusCount[];
}

const jobStatus = {
  Draft: 0,
  Confirmed: 1,
  Cancelled: 2,
  Started: 3,
  Completed: 4
};

const jobStatusNameEnum = Object.fromEntries(
  Object.entries(jobStatus).map(([name, id]) => [id, name])
);

// === Progress Calculation ===
function calculateJobProgress(job: any, today: Date): number {
  try {
    const planStart = new Date(job.actual_start_date);
    const planComplete = new Date(job.actual_complete_date);

    if (isNaN(planStart.getTime()) || isNaN(planComplete.getTime())) {
      return 0;
    }

    const MILLISECONDS_PER_DAY = 86400000;
    const totalPlanDays = Math.max(
      1,
      Math.ceil((planComplete.getTime() - planStart.getTime()) / MILLISECONDS_PER_DAY) + 1
    );

    if (today < planStart) {
      return 0;
    } else if (today > planComplete) {
      return 100;
    }

    const workedDays = Math.ceil((today.getTime() - planStart.getTime()) / MILLISECONDS_PER_DAY) + 1;
    return workedDays > 0 ? Math.round((workedDays / totalPlanDays) * 100) : 0;
  } catch (error) {
    console.error('Error calculating job progress:', error);
    return 0;
  }
}

function aggregateTradeSections(
  rows: any[],
  reportByTradeMap: Record<string, { wdrs_drafted: number; wdrs_completed: number }> = {}
): TradeSection[] {
  const today = new Date();
  const tradeMap: Record<string, any> = {};

  rows.forEach(row => {
    const tradeId = row.id ?? 'unassigned';
    const tradeName = row.id ? row.name : 'Unassigned Trade';

    if (!tradeMap[tradeId]) {
      tradeMap[tradeId] = { id: tradeId, name: tradeName, jobs: [] };
    }

    if (row.job_id) {
      tradeMap[tradeId].jobs.push(row);
    }
  });

  return Object.values(tradeMap).map((trade: any) => {
    const jobs = trade.jobs;

    // Actual progress = avg(progress)
    const actualProgress =
      jobs.length > 0
        ? jobs.reduce((sum: number, j: any) => sum + (Number(j.progress) || 0), 0) / jobs.length
        : 0;

    // Planned progress = avg(calculateJobProgress)
    const plannedProgress =
      jobs.length > 0
        ? jobs.reduce((sum: number, j: any) => sum + calculateJobProgress(j, today), 0) / jobs.length
        : 0;

    // Status counts
    const statusCountMap: Record<string, number> = {};
    jobs.forEach((j: any) => {
      const statusName = jobStatusNameEnum[j.status] || 'Unknown';
      statusCountMap[statusName] = (statusCountMap[statusName] || 0) + 1;
    });

    const status_count = Object.entries(statusCountMap).map(([status, count]) => ({ status, count }));

    // report counts from reportByTradeMap
    const reportCounts = reportByTradeMap[trade.id] || { wdrs_drafted: 0, wdrs_completed: 0 };

    return {
      id: trade.id,
      name: trade.name,
      total_job: jobs.length,
      actual_progress: Math.round(actualProgress * 100) / 100,
      planned_progress: Math.round(plannedProgress * 100) / 100,
      wdrs_drafted: reportCounts.wdrs_drafted,
      wdrs_completed: reportCounts.wdrs_completed,
      status_count
    };
  });
}

export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log("=== Get Project Progress API Called ===");
    const project_id = event.pathParameters?.id;

    if (!project_id) {
      return LambdaResponse.error(
        new ApiResponse(false, null, 'Project ID is required'),
        400
      );
    }

    if (!isValidUUID(project_id)) {
      return LambdaResponse.error(
        new ApiResponse(false, null, 'Invalid project ID format'),
        400
      );
    }

    const query = `SELECT 
        COUNT(j.id) as total_job,
        COUNT(CASE WHEN j.status = ${jobStatus['Completed']} THEN 1 END) as complete_job,
        COUNT(CASE WHEN j.status = ${jobStatus['Cancelled']} THEN 1 END) as cancel_job,
        COUNT(CASE WHEN j.status NOT IN (${jobStatus['Completed']}, ${jobStatus['Cancelled']}) THEN 1 END) as incomplete_job
      FROM projects p 
      LEFT JOIN jobs j ON j.project_id = p.id
      WHERE p.id = $1
      GROUP BY p.id`;

    const eachTradeQuery = `SELECT
        ts.id,
        ts.name,
        j.id AS job_id,
        j.progress,
        j.actual_start_date,
        j.actual_complete_date,
        j.status
      FROM (
        SELECT DISTINCT project_id, trade_section_id
        FROM project_trade_sections
        WHERE project_id = $1
      ) pts
      JOIN trade_sections ts ON pts.trade_section_id = ts.id
      LEFT JOIN jobs j ON j.project_id = $1 AND j.trade_section_id = ts.id
      
      UNION ALL

      SELECT
          NULL as id,
          NULL as name,
          j.id AS job_id,
          j.progress,
          j.actual_start_date,
          j.actual_complete_date,
          j.status
      FROM jobs j
      WHERE j.project_id = $1 AND j.trade_section_id IS NULL`;

    const reportProjectQuery = `SELECT
        COUNT(CASE WHEN is_published = false THEN 1 END) as wdrs_drafted,
        COUNT(CASE WHEN is_published = true THEN 1 END) as wdrs_completed
      FROM report
      WHERE project_id = $1`;

    const reportByTradeQuery = `SELECT
        COALESCE(r.trade_section, j.trade_section_id) AS trade_section_id,
        COUNT(CASE WHEN r.is_published = false THEN 1 END) as wdrs_drafted,
        COUNT(CASE WHEN r.is_published = true THEN 1 END) as wdrs_completed
      FROM report r
      LEFT JOIN jobs j ON r.job_id = j.id
      WHERE (r.project_id = $1 OR j.project_id = $1)
      GROUP BY COALESCE(r.trade_section, j.trade_section_id);`;

    const [result, eachTradeResult, reportProjectResult, reportByTradeResult] = await Promise.all([
      executeQuery(query, [project_id]),
      executeQuery(eachTradeQuery, [project_id]),
      executeQuery(reportProjectQuery, [project_id]),
      executeQuery(reportByTradeQuery, [project_id])
    ]);

    if (!result.success) {
      console.error("Database Error (project):", result.error);
      return LambdaResponse.error(
        new ApiResponse(false, null, result.error || 'Database query failed'),
        500
      );
    }

    if (!eachTradeResult.success) {
      console.error("Database Error (trade sections):", eachTradeResult.error);
      return LambdaResponse.error(
        new ApiResponse(false, null, eachTradeResult.error || 'Database query failed'),
        500
      );
    }

    if (!reportProjectResult.success) {
      console.error("Database Error (report project totals):", reportProjectResult.error);
      return LambdaResponse.error(
        new ApiResponse(false, null, reportProjectResult.error || 'Database query failed'),
        500
      );
    }

    if (!reportByTradeResult.success) {
      console.error("Database Error (report by trade):", reportByTradeResult.error);
      return LambdaResponse.error(
        new ApiResponse(false, null, reportByTradeResult.error || 'Database query failed'),
        500
      );
    }

    const projectData = result.data[0] || {};

    const reportByTradeRows: any[] = reportByTradeResult.data || [];
    const reportByTradeMap = reportByTradeRows.reduce(
      (acc: Record<string, { wdrs_drafted: number; wdrs_completed: number }>, row: any) => {
        const tradeId = row.trade_section_id ?? 'unassigned';
        acc[tradeId] = {
          wdrs_drafted: Number(row.wdrs_drafted) || 0,
          wdrs_completed: Number(row.wdrs_completed) || 0
        };
        return acc;
      },
      {}
    );

    const tradeSections = aggregateTradeSections(eachTradeResult.data, reportByTradeMap);
    tradeSections.sort((a: TradeSection, b: TradeSection) => a.name.localeCompare(b.name));

    const reportsData = reportProjectResult.data[0] || {
      wdrs_drafted: 0,
      wdrs_completed: 0
    };

    const responseData = {
      ...projectData,
      ...reportsData,
      trade_sections: tradeSections
    };

    return LambdaResponse.success(
      new ApiResponse(true, responseData, 'Project progress retrieved successfully')
    );

  } catch (error: any) {
    console.error('Unhandled Error:', error);
    return LambdaResponse.error(
      new ApiResponse(false, null, 'An unexpected error occurred while retrieving project progress'),
      500
    );
  }
};

function isValidUUID(uuid: string): boolean {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}
