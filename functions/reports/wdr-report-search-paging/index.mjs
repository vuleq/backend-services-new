import { executeQuery, logAPIError, logDatabaseError } from "wdr-connect-db";
import { ApiResponse, ResponsePage, LambdaResponse } from "wdr-models";
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
    console.log("Event:", JSON.stringify(event));
    // FIX: Use querystring params from mapping template
    const queryParams = event.queryStringParameters || {};

    // Accept filters from querystring only (per mapping template)
    const search = queryParams.search || null;
    const name = queryParams.name || null;
    let trade_section = queryParams.trade_section || null;
    const type = queryParams.type || null;
    const is_default = queryParams.is_default || null;
    const version = queryParams.version || null;
    const project_id = queryParams.project_id || null;
    const job_id = queryParams.job_id || null;
    const status = queryParams.status || null;
    const awrf_no = queryParams.awrf_no || null;
    const sub_code = queryParams.sub_code || null;
    const approver_id = queryParams.approver_id || null;
    const is_published = queryParams.is_published || null;
    const created_by = queryParams.created_by || null;

    // Validate and process sort parameters
    const validateAndProcessSort = (sortParam) => {
      const validColumns = [
        "document_no", "name", "type", "is_default", "version", "project_id",
        "job_id", "created_by", "created_at", "updated_at", "is_published",
        "thumbnail", "trade_section", "awrf_no", "sub_code", "job_title",
        "reporter", "status", "approver_name", "step_name", "owner_job_number"
      ];

      if (!sortParam || typeof sortParam !== "string") {
        return "ts.name ASC";
      }

      const sortClauses = sortParam
        .split(",")
        .map((clause) => {
          const trimmed = clause.trim();
          const parts = trimmed.split(/\s+/);

          if (parts.length < 1 || parts.length > 2) {
            return null;
          }

          const column = parts[0].toLowerCase();
          const direction = parts.length > 1 ? parts[1].toUpperCase() : "ASC";

          if (direction !== "ASC" && direction !== "DESC") {
            return null;
          }

          let actualColumn;
          switch (column) {
            case "document_no": case "name": case "type": case "is_default":
            case "version": case "project_id": case "job_id": case "created_by":
            case "created_at": case "updated_at": case "is_published":
            case "thumbnail": case "awrf_no":
            case "sub_code":
              actualColumn = `r.${column}`;
              break;
            case "reporter":
              actualColumn = "u.name";
              break;
            case "job_title":
              actualColumn = "j.title";
              break;
            case "trade_section":
              actualColumn = "ts.name";
              break;
            case "status":
              actualColumn = "r.is_published";
              break;
            case "owner_job_number":
              actualColumn = "j.owner_job_number";
              break;
            default:
              return null;
          }

          return `${actualColumn} ${direction}`;
        })
        .filter((clause) => clause !== null);

      if (sortClauses.length === 0) {
        return "ts.name ASC";
      }

      return sortClauses.join(", ");
    };

    const sort = validateAndProcessSort(queryParams.sort);

    // Pagination parameters
    const pageNumber = parseInt(queryParams.pageNumber) || 1;
    const pageSize = parseInt(queryParams.pageSize) || 10;
    const offset = (pageNumber - 1) * pageSize;

    let sql = `SELECT 
            r.id, 
            r.document_no, 
            r.name, 
            r.type, 
            r.is_default, 
            r.version, 
            r.project_id, 
            r.job_id, 
            r.created_by, 
            r.created_at, 
            r.updated_at, 
            r.is_published, 
            r.thumbnail, 
            r.trade_section, 
            r.awrf_no, 
            r.sub_code, 
            r.job_title,
            u.id as reporter_id,
            u.name as reporter_name,
            u.avt as reporter_avt,
            j.id as job_id_ref,
            j.title as job_title_ref,
            j.sub_code as job_sub_code,
            j.awrf_number as job_awrf_number,
            j.owner_job_number as job_owner_awrf_number,
            ts.id as trade_section_id,
            ts.name as trade_section_name
        FROM report r
        LEFT JOIN users u ON r.created_by = u.id
        LEFT JOIN jobs j ON r.job_id = j.id
        LEFT JOIN trade_sections ts ON r.trade_section = ts.id
        WHERE 1=1`;
    const params = [];
    let idx = 1;

    // Add all the existing filter conditions
    if (search) {
      sql += ` AND (r.name ILIKE $${idx} OR r.document_no ILIKE $${idx} OR r.sub_code ILIKE $${idx} OR r.awrf_no ILIKE $${idx} OR r.job_title ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    if (name) {
      sql += ` AND r.name ILIKE $${idx++}`;
      params.push(`%${name}%`);
    }

    if (trade_section !== null && trade_section !== undefined && trade_section !== "") {
      const tradeSections = trade_section.split(",").map((s) => s.trim()).filter(Boolean);
      if (tradeSections.length === 1) {
        sql += ` AND r.trade_section = $${idx++}`;
        params.push(tradeSections[0]);
      } else if (tradeSections.length > 1) {
        const inParams = tradeSections.map(() => `$${idx++}`).join(", ");
        sql += ` AND r.trade_section IN (${inParams})`;
        params.push(...tradeSections);
      }
    }

    if (type !== null && type !== undefined && type !== "") {
      const typeList = type.split(",").map((s) => s.trim()).filter(Boolean);
      if (typeList.length === 1) {
        sql += ` AND r.type = $${idx++}`;
        params.push(typeList[0]);
      } else if (typeList.length > 1) {
        const inParams = typeList.map(() => `$${idx++}`).join(", ");
        sql += ` AND r.type IN (${inParams})`;
        params.push(...typeList);
      }
    }

    if (is_default !== null && is_default !== undefined && is_default !== "") {
      sql += ` AND r.is_default = $${idx++}`;
      params.push(is_default);
    }

    if (version !== null && version !== undefined && version !== "") {
      sql += ` AND r.version = $${idx++}`;
      params.push(version);
    }

    if (project_id !== null && project_id !== undefined && project_id !== "") {
      sql += ` AND r.project_id = $${idx++}`;
      params.push(project_id);
    }

    if (job_id !== null && job_id !== undefined && job_id !== "") {
      sql += ` AND r.job_id = $${idx++}`;
      params.push(job_id);
    }

    if (status !== null && status !== undefined && status !== "") {
      sql += ` AND r.status = $${idx++}`;
      params.push(status);
    }

    if (awrf_no !== null && awrf_no !== undefined && awrf_no !== "") {
      sql += ` AND r.awrf_no = $${idx++}`;
      params.push(awrf_no);
    }

    if (sub_code !== null && sub_code !== undefined && sub_code !== "") {
      sql += ` AND r.sub_code = $${idx++}`;
      params.push(sub_code);
    }

    if (approver_id !== null && approver_id !== undefined && approver_id !== "") {
      sql += ` AND r.approver_id = $${idx++}`;
      params.push(approver_id);
    }

    if (is_published !== null && is_published !== undefined && is_published !== "") {
      sql += ` AND r.is_published = $${idx++}`;
      params.push(is_published);
    }

    if (created_by !== null && created_by !== undefined && created_by !== "") {
      const createdByList = created_by.split(",").map((s) => s.trim()).filter(Boolean);
      if (createdByList.length === 1) {
        sql += ` AND r.created_by = $${idx++}`;
        params.push(createdByList[0]);
      } else if (createdByList.length > 1) {
        const inParams = createdByList.map(() => `$${idx++}`).join(", ");
        sql += ` AND r.created_by IN (${inParams})`;
        params.push(...createdByList);
      }
    }

    // Store the WHERE clause for count query before adding ORDER BY
    const whereClause = sql.substring(sql.indexOf("WHERE 1=1"));

    // Build filter information for the count response
    const buildFilterInfo = () => {
      const filters = { parent: null };
      if (search) filters.search = search;
      if (name) filters.name = name;
      if (trade_section) filters.trade_section = trade_section;
      if (type) filters.type = type;
      if (is_default !== null) filters.is_default = is_default;
      if (version) filters.version = version;
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

    sql += ` ORDER BY ${sort}, r.created_at DESC`;

    console.log("SQL Query:", sql);
    console.log("Parameters:", params);

    // Update count queries - simplified to keep same logic as main query
    const countSql = `SELECT COUNT(*) as total_count FROM report r
        LEFT JOIN users u ON r.created_by = u.id
        LEFT JOIN jobs j ON r.job_id = j.id
        LEFT JOIN trade_sections ts ON r.trade_section = ts.id
        ${whereClause}`;
    const publishedCountSql = `SELECT COUNT(*) as published_count FROM report r
        LEFT JOIN users u ON r.created_by = u.id
        LEFT JOIN jobs j ON r.job_id = j.id
        LEFT JOIN trade_sections ts ON r.trade_section = ts.id
        ${whereClause} AND r.is_published = true`;
    const unpublishedCountSql = `SELECT COUNT(*) as unpublished_count FROM report r
        LEFT JOIN users u ON r.created_by = u.id
        LEFT JOIN jobs j ON r.job_id = j.id
        LEFT JOIN trade_sections ts ON r.trade_section = ts.id
        ${whereClause} AND r.is_published = false`;

    const [countResult, publishedCountResult, unpublishedCountResult] = await Promise.all([
      executeQuery(countSql, params),
      executeQuery(publishedCountSql, params),
      executeQuery(unpublishedCountSql, params),
    ]);

    // Validate query results
    if (!countResult?.success || !countResult?.data?.[0] ||
        !publishedCountResult?.success || !publishedCountResult?.data?.[0] ||
        !unpublishedCountResult?.success || !unpublishedCountResult?.data?.[0]) {
      logDatabaseError("Invalid database query results");
      console.error("Invalid database query results:", {
        countResult, publishedCountResult, unpublishedCountResult,
      });
      return LambdaResponse.error(
        buildError("DATABASE_ERROR", "Invalid database response")
      );
    }

    const totalCount = parseInt(countResult.data[0].total_count) || 0;
    const publishedCount = parseInt(publishedCountResult.data[0].published_count) || 0;
    const unpublishedCount = parseInt(unpublishedCountResult.data[0].unpublished_count) || 0;

    // Add pagination to the main query
    sql += ` LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(pageSize, offset);

    const result = await executeQuery(sql, params);

    if (!result || !Array.isArray(result.data)) {
      const emptyPage = new ResponsePage(pageNumber, pageSize, 0, []);
      emptyPage.counts = {
        total: 0,
        published: 0,
        unpublished: 0,
        available_types: reportType,
        applied_filters: buildFilterInfo(),
      };
      return LambdaResponse.success(
        new ApiResponse(true, emptyPage, "No parent reports found")
      );
    }

    console.log(`Found ${result.data.length} parent reports (parent = NULL)`);

    // Process the results based on type
    if (type == 3) {
      if (!project_id) {
        await logAPIError("Missing project_id parameter");
        return LambdaResponse.error(
          buildError("MISSING_PROJECT_ID", "project_id is required when type = 3 (report)")
        );
      }

      for (const report of result.data) {
        
        report.reporter = report.reporter_id ? {
          id: report.reporter_id,
          name: report.reporter_name,
          full_name: report.reporter_name,
          avt: report.reporter_avt,
        } : null;

        report.job = report.job_id_ref ? {
          id: report.job_id_ref,
          title: report.job_title_ref,
          sub_code: report.job_sub_code,
          awrf_number: report.job_awrf_number,
          owner_job_number: report.job_owner_awrf_number,
        } : new Job(report.job_id, report.job_title, report.sub_code, report.awrf_number, report.job_owner_awrf_number);

        report.trade_section = report.trade_section_id ? {
          id: report.trade_section_id,
          name: report.trade_section_name,
        } : null;

        // Clean up the extra fields
        delete report.reporter_id;
        delete report.reporter_name;
        delete report.reporter_avt;
        delete report.job_id_ref;
        delete report.job_title_ref;
        delete report.job_sub_code;
        delete report.job_awrf_number;
        delete report.trade_section_id;
        delete report.trade_section_name;
        delete report.job_owner_awrf_number;
      }

      const pagedResponse = new ResponsePage(pageNumber, pageSize, totalCount, result.data);
      pagedResponse.counts = {
        total: totalCount,
        published: publishedCount,
        unpublished: unpublishedCount,
        available_types: reportType,
        applied_filters: buildFilterInfo(),
      };
      return LambdaResponse.success(
        new ApiResponse(true, pagedResponse, "Parent reports retrieved successfully")
      );
    }

    if (type && type.split(",").length > 1 && 
        type.split(",").every((t) => t === "1" || t === "2")) {
      // Group by type (HEADER or FOOTER)
      const groupedByType = {};
      for (const report of result.data) {
        const t = report.type;
        if (!groupedByType[t]) {
          groupedByType[t] = [];
        }
        
        report.reporter = report.reporter_id ? {
          id: report.reporter_id,
          name: report.reporter_name,
          full_name: report.reporter_name,
          avt: report.reporter_avt,
        } : null;

        report.job = report.job_id_ref ? {
          id: report.job_id_ref,
          title: report.job_title_ref,
          sub_code: report.job_sub_code,
          awrf_number: report.job_awrf_number,
          owner_job_number: report.job_owner_awrf_number,
        } : new Job(report.job_id, report.job_title, report.sub_code, report.awrf_no, report.job_owner_awrf_number);

        report.trade_section = report.trade_section_id ? {
          id: report.trade_section_id,
          name: report.trade_section_name,
        } : null;

        // Clean up the extra fields
        delete report.reporter_id;
        delete report.reporter_name;
        delete report.reporter_avt;
        delete report.job_id_ref;
        delete report.job_title_ref;
        delete report.job_sub_code;
        delete report.job_awrf_number;
        delete report.trade_section_id;
        delete report.trade_section_name;

        groupedByType[t].push(report);
      }

      const groupedList = Object.entries(groupedByType).map(([type, reports]) => ({
        type: Number(type),
        type_name: type === "1" ? "Header" : type === "2" ? "Footer" : "",
        reports,
      }));

      const pagedResponse = new ResponsePage(pageNumber, pageSize, totalCount, groupedList);
      pagedResponse.counts = {
        total: totalCount,
        published: publishedCount,
        unpublished: unpublishedCount,
        available_types: reportType,
        applied_filters: buildFilterInfo(),
      };
      return LambdaResponse.success(
        new ApiResponse(true, pagedResponse, "Parent reports grouped by type retrieved successfully")
      );
    }

    // Default processing for other cases
    for (const report of result.data) {
      
      report.trade_section = report.trade_section_id ? {
        id: report.trade_section_id,
        name: report.trade_section_name,
      } : null;

      // Clean up the extra fields
      delete report.reporter_id;
      delete report.reporter_name;
      delete report.reporter_avt;
      delete report.job_id_ref;
      delete report.job_title_ref;
      delete report.job_sub_code;
      delete report.job_awrf_number;
      delete report.trade_section_id;
      delete report.trade_section_name;
    }

    const pagedResponse = new ResponsePage(pageNumber, pageSize, totalCount, result.data);
    pagedResponse.counts = {
      total: totalCount,
      published: publishedCount,
      unpublished: unpublishedCount,
      available_types: reportType,
    };
    return LambdaResponse.success(
      new ApiResponse(true, pagedResponse, "Parent reports retrieved successfully")
    );

  } catch (error) {
    console.error("Error:", error);
    await logDatabaseError("Unexpected database error");
    return LambdaResponse.error(buildError("DATABASE_ERROR", error.message));
  }
};

// Helper functions
const getProjectById = async (projectId) => {
  try {
    const sql = `SELECT id, vessel_name, main_code FROM projects WHERE id = $1`;
    const params = [projectId];
    const result = await executeQuery(sql, params);
    return LambdaResponse.success(
      new Project(result.data[0].id, result.data[0].vessel_name, result.data[0].main_code)
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
  constructor(id, name, avt) {
    this.id = id;
    this.name = name;
    this.full_name = name;
    this.avt = avt;
  }
}

const getUserById = async (userId) => {
  try {
    const sql = `SELECT id, name, avt FROM users WHERE id = $1`;
    const params = [userId];
    const result = await executeQuery(sql, params);
    return LambdaResponse.success(
      new Users(result.data[0].id, result.data[0].name, result.data[0].avt)
    );
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
};

class Job {
  constructor(id, title, sub_code, awrf_number, owner_job_number) {
    this.id = id;
    this.title = title;
    this.sub_code = sub_code;
    this.awrf_number = awrf_number;
    this.owner_job_number = owner_job_number;
  }
}

const getJobById = async (jobId) => {
  try {
    const sql = `SELECT id, title, sub_code, awrf_number, owner_job_number FROM jobs WHERE id = $1`;
    const params = [jobId];
    const result = await executeQuery(sql, params);
    return LambdaResponse.success(
      new Job(
        result.data[0].id,
        result.data[0].title,
        result.data[0].sub_code,
        result.data[0].awrf_number,
        result.data[0].owner_job_number
      )
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
    return LambdaResponse.success(
      new TradeSection(result.data[0].id, result.data[0].name)
    );
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
};