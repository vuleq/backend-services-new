import { executeQuery } from "wdr-connect-db";
import { ApiResponse, LambdaResponse } from "wdr-models";
import { buildError } from "wdr-error-codes";

const reportType = Object.freeze({
  TEMPLATE: 0,
  HEADER: 1,
  FOOTER: 2,
  REPORT: 3,
  COVER: 4,
});

export const handler = async (event) => {
  try {
    console.log("------------------------------");
    console.log("Event:", JSON.stringify(event));
    // FIX: Use querystring params from mapping template
    const queryParams = event.queryStringParameters || {};

    // Accept filters from querystring only (per mapping template)
    const search = queryParams.search || null; // General search across name, document_no, sub_code, awrf_no
    const name = queryParams.name || null;
    // trade_section: comma-separated list of UUIDs
    let trade_section = queryParams.trade_section || null;
    const type = queryParams.type || null;
    const is_default = queryParams.is_default || null;
    const version = queryParams.version || null;
    const parent = queryParams.parent || null;
    const project_id = queryParams.project_id || null;
    const job_id = queryParams.job_id || null;
    const status = queryParams.status || null;
    const awrf_no = queryParams.awrf_no || null;
    const sub_code = queryParams.sub_code || null;
    const approver_id = queryParams.approver_id || null;
    const is_published = queryParams.is_published || null;
    const created_by = queryParams.created_by || null;
    const sort = queryParams.sort || "trade_section ASC, created_at DESC";

    let sql = `SELECT id, document_no, name, type, is_default, version, project_id, job_id, created_by, created_at, updated_at, is_published, thumbnail, trade_section, awrf_no, sub_code, job_title FROM report WHERE 1=1`;
    const params = [];
    let idx = 1;

    // General search across multiple fields
    if (search) {
      sql += ` AND (document_no ILIKE $${idx} OR sub_code ILIKE $${idx} OR awrf_no ILIKE $${idx} OR job_title ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    if (name) {
      sql += ` AND name ILIKE $${idx++}`;
      params.push(`%${name}%`);
    }
    if (
      trade_section !== null &&
      trade_section !== undefined &&
      trade_section !== ""
    ) {
      // If trade_section is a comma-separated list, use IN clause
      const tradeSections = trade_section
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (tradeSections.length === 1) {
        sql += ` AND trade_section = $${idx++}`;
        params.push(tradeSections[0]);
      } else if (tradeSections.length > 1) {
        const inParams = tradeSections.map(() => `$${idx++}`).join(", ");
        sql += ` AND trade_section IN (${inParams})`;
        params.push(...tradeSections);
      }
    }
    if (type !== null && type !== undefined && type !== "") {
      // If type is a comma-separated list, use IN clause
      const typeList = type
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (typeList.length === 1) {
        sql += ` AND type = $${idx++}`;
        params.push(typeList[0]);
      } else if (typeList.length > 1) {
        const inParams = typeList.map(() => `$${idx++}`).join(", ");
        sql += ` AND type IN (${inParams})`;
        params.push(...typeList);
      }
    }
    if (is_default !== null && is_default !== undefined && is_default !== "") {
      sql += ` AND is_default = $${idx++}`;
      params.push(is_default);
    }
    if (version !== null && version !== undefined && version !== "") {
      sql += ` AND version = $${idx++}`;
      params.push(version);
    }
    if (parent !== null && parent !== undefined && parent !== "") {
      sql += ` AND parent = $${idx++}`;
      params.push(parent);
    }
    if (project_id !== null && project_id !== undefined && project_id !== "") {
      sql += ` AND project_id = $${idx++}`;
      params.push(project_id);
    }
    if (job_id !== null && job_id !== undefined && job_id !== "") {
      sql += ` AND job_id = $${idx++}`;
      params.push(job_id);
    }
    if (status !== null && status !== undefined && status !== "") {
      sql += ` AND status = $${idx++}`;
      params.push(status);
    }
    if (awrf_no !== null && awrf_no !== undefined && awrf_no !== "") {
      sql += ` AND awrf_no = $${idx++}`;
      params.push(awrf_no);
    }
    if (sub_code !== null && sub_code !== undefined && sub_code !== "") {
      sql += ` AND sub_code = $${idx++}`;
      params.push(sub_code);
    }
    if (
      approver_id !== null &&
      approver_id !== undefined &&
      approver_id !== ""
    ) {
      sql += ` AND approver_id = $${idx++}`;
      params.push(approver_id);
    }
    if (
      is_published !== null &&
      is_published !== undefined &&
      is_published !== ""
    ) {
      sql += ` AND is_published = $${idx++}`;
      params.push(is_published);
    }
    if (created_by !== null && created_by !== undefined && created_by !== "") {
      // If created_by is a comma-separated list, use IN clause
      const createdByList = created_by
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (createdByList.length === 1) {
        sql += ` AND created_by = $${idx++}`;
        params.push(createdByList[0]);
      } else if (createdByList.length > 1) {
        const inParams = createdByList.map(() => `$${idx++}`).join(", ");
        sql += ` AND created_by IN (${inParams})`;
        params.push(...createdByList);
      }
    }

    // Store the WHERE clause for count query before adding ORDER BY
    const whereClause = sql.substring(sql.indexOf("WHERE 1=1"));

    // Build filter information for the count response
    const buildFilterInfo = () => {
      const filters = {};
      if (search) filters.search = search;
      if (name) filters.name = name;
      if (trade_section) filters.trade_section = trade_section;
      if (type) filters.type = type;
      if (is_default !== null) filters.is_default = is_default;
      if (version) filters.version = version;
      if (parent) filters.parent = parent;
      if (project_id) filters.project_id = project_id;
      if (job_id) filters.job_id = job_id;
      if (status) filters.status = status;
      if (awrf_no) filters.awrf_no = awrf_no;
      if (sub_code) filters.sub_code = sub_code;
      if (approver_id) filters.approver_id = approver_id;
      if (is_published !== null) filters.is_published = is_published;
      if (created_by) filters.created_by = created_by;
      return filters;
    };

    sql += ` ORDER BY ${sort}`;

    // Get comprehensive count statistics matching the search criteria
    const countSql = `SELECT COUNT(*) as total_count FROM report ${whereClause}`;
    const publishedCountSql = `SELECT COUNT(*) as published_count FROM report ${whereClause} AND is_published = true`;
    const unpublishedCountSql = `SELECT COUNT(*) as unpublished_count FROM report ${whereClause} AND is_published = false`;

    const [result, countResult, publishedCountResult, unpublishedCountResult] =
      await Promise.all([
        executeQuery(sql, params),
        executeQuery(countSql, params),
        executeQuery(publishedCountSql, params),
        executeQuery(unpublishedCountSql, params),
      ]);

    // Validate query results
    if (
      !countResult?.success ||
      !countResult?.data?.[0] ||
      !publishedCountResult?.success ||
      !publishedCountResult?.data?.[0] ||
      !unpublishedCountResult?.success ||
      !unpublishedCountResult?.data?.[0]
    ) {
      console.error("Invalid database query results:", {
        countResult,
        publishedCountResult,
        unpublishedCountResult,
      });
      return LambdaResponse.error(
        buildError("DATABASE_ERROR", "Invalid database response")
      );
    }

    const totalCount = parseInt(countResult.data[0].total_count) || 0;
    const publishedCount =
      parseInt(publishedCountResult.data[0].published_count) || 0;
    const unpublishedCount =
      parseInt(unpublishedCountResult.data[0].unpublished_count) || 0;

    if (!result || !Array.isArray(result.data)) {
      return LambdaResponse.success(
        new ApiResponse(
          true,
          {
            items: [],
            counts: {
              total: 0,
              published: 0,
              unpublished: 0,
              available_types: reportType,
              applied_filters: buildFilterInfo(),
            },
          },
          "No reports found"
        )
      );
    }

    if (type == 3) {
      // Group the result by project object (using getProjectById)
      const groupedByProject = {};
      for (const report of result.data) {
        const pid = report.project_id || "null";
        const project = await getProjectById(pid);
        if (!groupedByProject[pid]) {
          // Await getProjectById for each unique project_id
          groupedByProject[pid] = {
            project: project,
            reports: [],
          };
        }
        report.reporter = await getUserById(report.created_by);
        // report.job = await getJobById(report.job_id);
        report.job = new Job(
          report.job_id,
          report.job_title,
          report.sub_code,
          report.awrf_no
        );
        report.trade_section = await getTradeSectionById(report.trade_section);
        groupedByProject[pid].reports.push(report);
      }
      // Convert groupedByProject to array of { project, reports }
      const groupedList = Object.values(groupedByProject);
      return LambdaResponse.success(
        new ApiResponse(
          true,
          {
            items: groupedList,
            counts: {
              total: totalCount,
              published: publishedCount,
              unpublished: unpublishedCount,
              available_types: reportType,
              applied_filters: buildFilterInfo(),
            },
          },
          "Reports retrieved successfully"
        )
      );
    }

    if (
      type &&
      type.split(",").length > 1 &&
      type.split(",").every((t) => t === "1" || t === "2")
    ) {
      // Group by type (HEADER or FOOTER)
      const groupedByType = {};
      for (const report of result.data) {
        const t = report.type;
        if (!groupedByType[t]) {
          groupedByType[t] = [];
        }
        report.reporter = await getUserById(report.created_by);
        report.job = new Job(
          report.job_id,
          report.job_title,
          report.sub_code,
          report.awrf_no
        );
        report.trade_section = await getTradeSectionById(report.trade_section);
        groupedByType[t].push(report);
      }
      // Convert to array of { type, type_name, reports }
      const groupedList = Object.entries(groupedByType).map(
        ([type, reports]) => ({
          type: Number(type),
          type_name: type === "1" ? "Header" : type === "2" ? "Footer" : "",
          reports,
        })
      );
      return LambdaResponse.success(
        new ApiResponse(
          true,
          {
            items: groupedList,
            counts: {
              total: totalCount,
              published: publishedCount,
              unpublished: unpublishedCount,
              available_types: reportType,
              applied_filters: buildFilterInfo(),
            },
          },
          "Reports grouped by type retrieved successfully"
        )
      );
    }

    for (const report of result.data) {
      report.trade_section = await getTradeSectionById(report.trade_section);
    }
    return LambdaResponse.success(
      new ApiResponse(
        true,
        {
          items: result.data,
          counts: {
            total: totalCount,
            published: publishedCount,
            unpublished: unpublishedCount,
            available_types: reportType,
            applied_filters: buildFilterInfo(),
          },
        },
        "Reports retrieved successfully"
      )
    );
  } catch (error) {
    console.error("Error:", error);
    return LambdaResponse.error(buildError("DATABASE_ERROR", error.message));
  }
};

const getProjectById = async (projectId) => {
  try {
    const sql = `SELECT id, vessel_name, main_code FROM projects WHERE id = $1`;
    const params = [projectId];
    const result = await executeQuery(sql, params);
    return new Project(
      result.data[0].id,
      result.data[0].vessel_name,
      result.data[0].main_code
    );
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
};

class Project {
  constructor(id, vessel_name, main_code) {
    this.id = id;
    this.vessel_name = vessel_name;
    this.main_code = main_code;
  }
}

class Users {
  constructor(id, family_name, middle_name, given_name, avt) {
    this.id = id;
    this.family_name = family_name;
    this.middle_name = middle_name;
    this.given_name = given_name;
    this.full_name = combineFullName(this);
    this.avt = avt;
  }
}

const getUserById = async (userId) => {
  try {
    const sql = `SELECT id, family_name, middle_name, given_name, avt FROM users WHERE id = $1`;
    const params = [userId];
    const result = await executeQuery(sql, params);
    return new Users(
      result.data[0].id,
      result.data[0].family_name,
      result.data[0].middle_name,
      result.data[0].given_name,
      result.data[0].avt
    );
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
};

const combineFullName = (user) => {
  if (!user) return "";
  const names = [user.given_name, user.middle_name, user.family_name].filter(
    (name) => name && name.trim() !== ""
  );
  return names.join(" ");
};

class Job {
  constructor(id, title, sub_code, awrf_number) {
    this.id = id;
    this.title = title;
    this.sub_code = sub_code;
    this.awrf_number = awrf_number;
  }
}

const getJobById = async (jobId) => {
  try {
    const sql = `SELECT id, title, sub_code, awrf_number FROM jobs WHERE id = $1`;
    const params = [jobId];
    const result = await executeQuery(sql, params);
    return new Job(
      result.data[0].id,
      result.data[0].title,
      result.data[0].sub_code,
      result.data[0].awrf_number
    );
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
};

class TradeSection {
  constructor(id, name) {
    this.id = id;
    this.name = name;
  }
}

const getTradeSectionById = async (tradeSectionId) => {
  try {
    const sql = `SELECT id, name FROM trade_sections WHERE id = $1`;
    const params = [tradeSectionId];
    const result = await executeQuery(sql, params);
    return new TradeSection(result.data[0].id, result.data[0].name);
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
};
