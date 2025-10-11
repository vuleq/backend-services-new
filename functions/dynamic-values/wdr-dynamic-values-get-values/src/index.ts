import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { executeQuery } from "wdr-connect-db";
import { ApiResponse, LambdaResponse } from "wdr-models";
import { buildError } from "wdr-error-codes";

interface DynamicRow {
  report_id: string;
  prepared_by: string;
  created_at: string;
  updated_at: string;
  job_title: string;
  owner_ref_no: string;
  trade_section_name: string;
  sub_code_no: string;
  project_main_code: string;
  vessel_name: string;
  owner_rep: string;
  assigned_users: { name: string; role_code: string; role: number }[];
}

// Mapping pre_define.name → DynamicRow property
const fieldMapping: Record<string, keyof DynamicRow | "COMM_IN_CHARGE" | "SRM"> = {
  "Vessel Name": "vessel_name",
  "Owner Ref": "owner_ref_no",
  "Main Code": "project_main_code",
  "Sub Code": "sub_code_no",
  "Prepared By": "prepared_by",
  "Date": "created_at",
  "Owner Rep": "owner_rep",
  "Trade Sections": "trade_section_name",
  "Trade Sections (Uppercase)": "trade_section_name",
  "Job Title": "job_title",
  "Comm. In Charge": "COMM_IN_CHARGE",
  "SRM": "SRM"
};

// Enum mapping
const roleEnum: Record<string, number> = {
  SU: 0,
  SRM: 1,
  SO: 2,
  COA: 3,
  CO: 4,
  VGM: 5,
};

// Reverse mapping: số → code
const reverseRoleEnum: Record<number, string> = Object.fromEntries(
  Object.entries(roleEnum).map(([k, v]) => [v, k])
);


export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log("Receive Event:", event);

  try {
    const body = JSON.parse(event.body || '{}');
    const reportIds = body.report_ids;

    if (!Array.isArray(reportIds) || reportIds.length === 0) {
      return LambdaResponse.error(
        buildError("VALIDATION_ERROR", "At least one report_id is required"),
        400
      );
    }

    // Query report data
    const query = `
      SELECT 
        r.id AS report_id,
        r.created_by,
        ru.name AS prepared_by,
        r.created_at,
        r.updated_at,
        j.title AS job_title,
        j.owner_job_number AS owner_ref_no,
        ts.name AS trade_section_name,
        sb.sub_no AS sub_code_no,
        p.main_code AS project_main_code,
        p.vessel_name,
        p.owner_rep,
        (
          SELECT COALESCE(json_agg(json_build_object(
            'name', u.name,
            'role_code', pa.role_code,
            'role', pa.role
          )), '[]'::json)
          FROM project_assignments pa
          JOIN users u ON pa.user_id = u.id
          WHERE pa.project_id = p.id
        ) AS assigned_users
      FROM report r
      JOIN jobs j ON r.job_id = j.id
      JOIN projects p ON j.project_id = p.id
      LEFT JOIN sub_codes sb ON j.sub_code = sb.id
      LEFT JOIN trade_sections ts ON ts.id = j.trade_section_id
      LEFT JOIN users ru ON r.created_by = ru.id
      WHERE r.id = ANY($1)
      ORDER BY r.created_at ASC
    `;

    const result = await executeQuery(query, [reportIds]);
    if (!result.success || result.data.length === 0) {
      return LambdaResponse.error(
        buildError("NOT_FOUND", "Reports not found"),
        404
      );
    }

    const rows: DynamicRow[] = result.data;

    // Fetch dynamic fields from pre_define
    const mappingQuery = `
      SELECT id, name, description
      FROM pre_defined
      WHERE type = 2
      ORDER BY name ASC
    `;
    const mappingResult = await executeQuery(mappingQuery, []);
    const mappingRows = mappingResult.success ? mappingResult.data : [];

    // Build dynamic response in {id, name, description, value} format
    const response = mappingRows.map((m: any) => {
      const fieldKey = fieldMapping[m.name];
      let value: any = null;

      if (m.name === "Date") {
        value = new Date().toISOString();
      } else if (fieldKey === "COMM_IN_CHARGE" || fieldKey === "SRM") {
        const targetCode = fieldKey === "COMM_IN_CHARGE" ? "CO" : "SRM";
        const users = rows
          .flatMap(row => row.assigned_users || [])
          .filter(u => u.role_code === targetCode || reverseRoleEnum[u.role] === targetCode)
          .map(u => u.name)
          .filter(Boolean);
        value = [...new Set(users)].join(", ") || null;
      } else {
        const values = rows.map(row => row[fieldKey]).filter(Boolean);
        value = [...new Set(values)].join(", ") || null;
      }
      if (m.name === "Trade Sections (Uppercase)" && value) {
        value = value.toUpperCase();
      }

      return {
        id: m.id,
        name: `[${m.name}]`,
        description: m.description,
        value
      };
    });

    return LambdaResponse.success(
      new ApiResponse(true, response, "Dynamic values retrieved successfully")
    );

  } catch (error: any) {
    console.error("Error:", error);
    return LambdaResponse.error(
      buildError("DATABASE_ERROR", error.message || "Unknown error")
    );
  }
};
