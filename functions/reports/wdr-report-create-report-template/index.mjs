import { executeQuery } from "wdr-connect-db";
import { ApiResponse, LambdaResponse } from "wdr-models";
import { buildError } from "wdr-error-codes";

const reportType = Object.freeze({
  TEMPLATE: 0,
  COVER: 1,
  HEADER_FOOTER: 2,
  REPORT: 3,
});

export const handler = async (event) => {
  try {
    console.log("Event:", JSON.stringify(event));
    const requestBody = event.body || {};

    // Basic validation
    if (!requestBody || Object.keys(requestBody).length === 0) {
      const err = buildError("INVALID_REQUEST");
      return LambdaResponse.error(
        new ApiResponse(false, null, err.message, err.code, err.errorCode)
      );
    }

    // Required fields validation (customize as needed)
    if (
      !requestBody.name ||
      requestBody.trade_section === undefined ||
      requestBody.type === undefined
    ) {
      const err = buildError(
        "MISSING_REQUIRED_FIELD",
        "name, trade_section, type are required."
      );
      return LambdaResponse.error(
        new ApiResponse(false, null, err.message, err.code, err.errorCode)
      );
    }

    // Validate report type
    if (!Object.values(reportType).includes(requestBody.type)) {
      const err = buildError("ENTITY_VALIDATION_FAILED", "Invalid report type");
      return LambdaResponse.error(
        new ApiResponse(false, null, err.message, err.code, err.errorCode)
      );
    }

    // Check for unique name (case-sensitive, same type and trade_section)
    const checkNameSql = `SELECT id FROM report WHERE name = $1 AND type = $2 AND trade_section = $3 LIMIT 1`;
    const checkNameParams = [
      requestBody.name,
      requestBody.type,
      requestBody.trade_section,
    ];
    const nameExists = await executeQuery(checkNameSql, checkNameParams);
    if (nameExists.data[0] && nameExists.rowCount > 0) {
      const err = buildError(
        "RESOURCE_ALREADY_EXISTS",
        "Report name already exists in this type and trade section"
      );
      return LambdaResponse.error(
        new ApiResponse(false, null, err.message, err.code, err.errorCode)
      );
    }

    // Only one default template per trade_section and type
    if (requestBody.is_default === true) {
      const checkDefaultSql = `SELECT id FROM report WHERE is_default = true AND type = $1 AND trade_section = $2 LIMIT 1`;
      const checkDefaultParams = [requestBody.type, requestBody.trade_section];
      const defaultExists = await executeQuery(
        checkDefaultSql,
        checkDefaultParams
      );
      if (defaultExists.data[0] && defaultExists.rowCount > 0) {
        const err = buildError(
          "BUSINESS_RULE_VIOLATION",
          "There is already a default template for this type and trade section"
        );
        return LambdaResponse.error(
          new ApiResponse(false, null, err.message, err.code, err.errorCode)
        );
      }
    }

    const now = new Date().toISOString();

    // PostgreSQL uses $1, $2, etc. for parameterized queries, not ?
    const sql = `
          INSERT INTO report (
            name, trade_section, type, is_default, content, version, parent, project_id, job_id,
            created_at, created_by, updated_at, updated_by, status, awrf_no, sub_code, approver_id, is_published, thumbnail
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
          )
          RETURNING *
        `;

    const params = [
      requestBody.name,
      requestBody.trade_section,
      requestBody.type,
      requestBody.type === 3 ? false : requestBody.is_default ?? false,
      requestBody.content ?? null,
      requestBody.version ?? null,
      requestBody.parent ?? null,
      requestBody.project_id ?? null,
      requestBody.job_id ?? null,
      requestBody.created_at ?? now,
      requestBody.created_by ?? null,
      requestBody.updated_at ?? now,
      requestBody.updated_by ?? null,
      requestBody.status ?? null,
      requestBody.awrf_no ?? null,
      requestBody.sub_code ?? null,
      requestBody.approver_id ?? null,
      requestBody.is_published ?? false,
      requestBody.thumbnail ?? null,
    ];

    try {
      const result = await executeQuery(sql, params);
      return LambdaResponse.success(
        new ApiResponse(true, result.data[0], "Report created successfully")
      );
    } catch (error) {
      console.error("Error:", error);
      const err = buildError("DATABASE_ERROR", error.message);
      return LambdaResponse.error(
        new ApiResponse(false, null, err.message, err.code, err.errorCode)
      );
    }
  } catch (error) {
    console.error("Error:", error);
    const err = buildError("DATABASE_ERROR", error.message);
    return LambdaResponse.error(
      new ApiResponse(false, null, err.message, err.code, err.errorCode)
    );
  }
};
