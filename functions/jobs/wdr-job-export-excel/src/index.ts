import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ApiResponse, LambdaResponse } from "wdr-models";
import { ERROR_CODES } from "wdr-error-codes";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { Writable } from "stream";
import { executeQuery } from "wdr-connect-db";
import ExcelJS from "exceljs";

// Client
const s3Client = new S3Client({});
const lambdaClient = new LambdaClient({});

// Config
const HEADER_ROW_INDEX: number = 10;

const FIELD_TO_HEADER: Record<string, string> = {
  title: "Job Title",
  sub_code_name: "Sub Code",
  trade_section_name: "Trade Section",
  job_type: "Job Type",
  owner_job_number: "Owner Job No",
  status: "Job Status",
  wdr_status: "WDR Status",
  awrf_number: "AWRF No",
  description: "Job Description",
  plan_start_date: "Plan Start Date",
  plan_complete_date: "Plan Completion Date",
  actual_start_date: "Actual Start Date",
  actual_complete_date: "Actual Completion Date",
  assignee: "Assignee",
  create_date: "Created Date",
  update_date: "Updated Date",
  remark: "Remarks",
  actual_process: "Progress",
};

const roleEnum: Record<string, number> = {
  SU: 0,
  SRM: 1,
  SO: 2,
  COA: 3,
  CO: 4,
  VGM: 5,
};

// Helpers
const formatDate = (dateStr?: string | null): string => {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "";

  const day = String(date.getDate()).padStart(2, "0");

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[date.getMonth()];

  const year = date.getFullYear();

  return `${day}/${month}/${year}`;
};

const formatAssignee = (assignees: any[]): string =>
  assignees?.map((a) => a.name).join(", ") || "";

const getValidParams = (params: Record<string, string | string[]> = {}) =>
  Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) =>
        Array.isArray(value) ? value.length > 0 : value?.trim() !== ""
      )
  );

function buildLambdaPayload(params: Record<string, string | string[]>, token?: string) {
  const validParams = getValidParams(params);

  const queryStringParameters: Record<string, string> = {};
  const multiValueQueryStringParameters: Record<string, string[]> = {};

  for (const [key, value] of Object.entries(validParams)) {
    if (Array.isArray(value)) {
      multiValueQueryStringParameters[key] = value.map(v => v.toString());
    } else {
      queryStringParameters[key] = value.toString();
    }
  }

  queryStringParameters["no-paging"] = "true";

  return {
    queryStringParameters,
    multiValueQueryStringParameters,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  };
}

export const fetchJobs = async (params: Record<string, string | string[]>, token?: string): Promise<any[]> => {
  const payload = buildLambdaPayload(params, token);

  const command = new InvokeCommand({
    FunctionName: process.env.JOB_SEARCH_FUNCTION_NAME,
    Payload: Buffer.from(JSON.stringify(payload)),
    InvocationType: "RequestResponse"
  });

  const response = await lambdaClient.send(command);

  if (!response.Payload) return [];

  const lambdaResult = JSON.parse(Buffer.from(response.Payload).toString());
  const body =
    typeof lambdaResult.body === "string"
      ? JSON.parse(lambdaResult.body)
      : lambdaResult.body;

  return body?.data?.data ?? [];
};

// Styles
const headerStyle = {
  font: { name: "Times New Roman", size: 12, bold: true },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF00" } },
  alignment: { vertical: "middle", horizontal: "center", wrapText: true },
  border: {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  },
};

const bodyStyle = {
  font: { name: "Times New Roman", size: 11 },
  alignment: { vertical: "middle", horizontal: "left", wrapText: true },
  border: {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  },
};

const writeHeaderRow = (ws: ExcelJS.Worksheet, fields: string[]) => {
  const row = ws.getRow(HEADER_ROW_INDEX);
  row.values = ["No", ...fields.map((f) => FIELD_TO_HEADER[f] || f)];
  row.eachCell((c, colNumber) => {
    Object.assign(c, headerStyle);
    const headerLength = c.value ? c.value.toString().length : 10;
    ws.getColumn(colNumber).width = headerLength + 2;
  });  row.commit();
};

const writeJobData = (ws: ExcelJS.Worksheet, jobs: any[], fields: string[]) => {
  let rowIndex = HEADER_ROW_INDEX + 1;
  jobs.forEach((job, i) => {
    const values = [
      i + 1,
      ...fields.map((f) => {
        if (f.toLowerCase().includes("date")) return formatDate(job[f]);
        if (f === "assignee") return formatAssignee(job[f]);
        if (f.toLowerCase().includes("actual_process")) {
          const val = job[f];
          return val != null && val !== "" ? `${val}%` : "";
        }
        // if (f === "supporting_job") return job[f] ? "Support" : "Main";
        return job[f] ?? "";
      }),
    ];
    const row = ws.getRow(rowIndex++);
    row.values = values;
    row.eachCell((c, colNumber) => {
      Object.assign(c, bodyStyle);

      if (c.value) {
        const text = c.value.toString();
        const currentWidth = ws.getColumn(colNumber).width || 10;
        const newWidth = Math.min(Math.max(text.length + 2, currentWidth), 50);
        ws.getColumn(colNumber).width = newWidth;

        const approxLines = Math.ceil(text.length / (ws.getColumn(colNumber).width || 10));
        row.height = Math.max(row.height || 15, approxLines * 15);
      }
    });

    row.commit();
  });
};

// === PLACEHOLDER MAPPING ===
const buildPlaceholders = (project: any): Record<string, string> => {
  const findUsersByRole = (roleCode: string): string => {
    const roleNumber = roleEnum[roleCode];
    return (
      project.assigned_users
        ?.filter((u: any) => {
          if (u.role_code) return u.role_code === roleCode;
          return u.role === roleNumber;
        })
        .map((u: any) => u.name)
        .join(", ") || ""
    );
  };
  return {
    vessel_name: project.vessel_name || "",
    main_code: project.main_code || "",
    owner_rep: project.owner_rep || "",
    ship_contact: project.ship_contact || "",
    vscc_meeting_time: project.vscc_meeting_time ? formatDate(project.vscc_meeting_time) : "",
    vessel_size: project.vessel_size
      ? `L ${project.vessel_size.length} m x W ${project.vessel_size.width} m x H ${project.vessel_size.height} m`
      : "",
    arrival_date: formatDate(project.arrival_date),
    departure_date: formatDate(project.departure_date),
    docking_date: formatDate(project.docking_date),
    undocking_date: formatDate(project.undocking_date),
    remark: project.remark || "",
    SRM: findUsersByRole("SRM"),
    SO: findUsersByRole("SO"),
    CO: findUsersByRole("CO"),
  };
};

const replacePlaceholders = (ws: ExcelJS.Worksheet, placeholders: Record<string, string>) => {
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      if (typeof cell.value === "string") {
        const matches = cell.value.match(/{{(.*?)}}/g);
        if (matches) {
          let newValue = cell.value;
          matches.forEach((m) => {
            const key = m.replace(/[{}]/g, "");
            if (placeholders[key] !== undefined) {
              newValue = newValue.replace(m, placeholders[key]);
            }
          });
          cell.value = newValue;
        }
      }
    });
  });
};

// Lambda Handler
export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  try {
    if (!event.body) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Missing body", ERROR_CODES.INVALID_REQUEST.code),
        400
      );
    }
    const rawToken = event.headers?.Authorization || event.headers?.authorization || "";
    const token = rawToken.startsWith("Bearer ") ? rawToken.slice(7) : rawToken;

    const body = JSON.parse(event.body);
    const { params = {}, header: headerFields = [] } = body;

    const bucket = process.env.EXPORT_BUCKET;
    const key = process.env.FILE_KEY;
    if (!bucket || !key) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          "Missing EXPORT_BUCKET or FILE_KEY env",
          ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code
        ),
        500
      );
    }

    // 1. Fetch jobs
    const jobs = await fetchJobs(params, token);
    console.log(params)

    // 2. Get project from DB
    const projectQuery = `
      SELECT p.id, p.main_code, p.vessel_name, p.owner_rep, p.ship_contact,
             p.vscc_meeting_time, p.vessel_size, p.arrival_date, p.departure_date,
             p.docking_date, p.undocking_date, p.remark,
             (
               SELECT COALESCE(json_agg(json_build_object(
                 'id', pa.id, 'user_id', u.id, 'name', u.name, 'role_code', pa.role_code,'role', pa.role
               )), '[]'::json)
               FROM project_assignments pa
               JOIN users u ON pa.user_id = u.id
               WHERE pa.project_id = p.id
             ) as assigned_users
      FROM projects p
      WHERE p.id = $1
      GROUP BY p.id;
    `;
    const projectRes = await executeQuery(projectQuery, [body.params['project-id']]);
    const project: any = projectRes?.data?.[0] || {};
    console.log("Project: ", project)

    // 3. Load Excel template
    const getCmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const s3Response = await s3Client.send(getCmd);
    if (!s3Response.Body) throw new Error("Empty S3 response body");

    const templateBuffer = Buffer.from(await (s3Response.Body as any).transformToByteArray());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(templateBuffer as any);

    const worksheet = workbook.getWorksheet("new") || workbook.getWorksheet(1);
    if (!worksheet) throw new Error("Worksheet not found in template");

    // 4. Replace placeholders
    const placeholders = buildPlaceholders(project);
    replacePlaceholders(worksheet, placeholders);

    // 5. Write header + data
    writeHeaderRow(worksheet, headerFields);
    writeJobData(worksheet, jobs, headerFields);

    // 6. Write to buffer via stream
    const chunks: Buffer[] = [];
    await workbook.xlsx.write(
      new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk as Buffer);
          cb();
        },
      })
    );
    const buffer = Buffer.concat(chunks);
    const base64Data = buffer.toString("base64");

    const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
    const fileName = `export_worklist_${timestamp}.xlsx`;

    const duration = Date.now() - startTime;
    console.log(`Excel generated in ${duration}ms, size=${buffer.length / 1024}KB`);

    return LambdaResponse.success(
      new ApiResponse(
        true,
        {
          fileName,
          fileData: base64Data,
          size: Math.round(Buffer.byteLength(base64Data, "base64") / 1024),
        },
        "File generated successfully",
        ERROR_CODES.SUCCESS.code
      )
    );
  } catch (error: any) {
    console.error("Unexpected error in handler:", error);
    return LambdaResponse.error(
      new ApiResponse(
        false,
        null,
        error.message || "Unexpected error",
        ERROR_CODES.LAMBDA_SERVICE_EXCEPTION.code
      ),
      500
    );
  }
};
