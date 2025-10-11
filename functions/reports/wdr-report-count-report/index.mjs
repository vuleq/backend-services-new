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
    console.log("Event:", JSON.stringify(event));
    const queryParams = event.queryStringParameters || {};

    // Get optional type filter from multiple sources (body, query, or path parameters)
    let typeFilter = queryParams.type;
    let typeFilters = [];

    // Convert string to array of numbers if needed
    if (typeFilter !== undefined && typeFilter !== null) {
      // Handle comma-separated string like "1,2,3"
      const typeStrings = typeFilter
        .toString()
        .split(",")
        .map((t) => t.trim());
      typeFilters = typeStrings
        .map((t) => parseInt(t))
        .filter((t) => !isNaN(t));

      // Validate that all types are within our enum range
      const invalidTypes = typeFilters.filter(
        (t) => !Object.values(reportType).includes(t)
      );
      if (invalidTypes.length > 0) {
        return LambdaResponse.error(
          buildError(
            "INVALID_REQUEST",
            `Invalid report type(s): ${invalidTypes.join(
              ", "
            )}. Valid types are: ${Object.keys(reportType).join(", ")}`
          )
        );
      }
    }

    // Add optional project_id filter
    const projectId = queryParams.project_id;
    let projectClause = "";
    if (projectId) {
      projectClause = " AND project_id = $";
    }

    // Build queries with proper parameter handling
    let totalSql, publishedSql, unpublishedSql;
    let totalParams, publishedParams, unpublishedParams;

    if (typeFilters.length > 0) {
      // When type filters are provided, use parameterized queries
      let baseIdx = typeFilters.length + 1;
      const placeholders = typeFilters
        .map((_, index) => `$${index + 1}`)
        .join(",");
      let projectFilter = "";
      if (projectId) {
        projectFilter = ` AND project_id = $${baseIdx}`;
      }
      totalSql = `
                SELECT COUNT(*) as total_count 
                FROM report 
                WHERE type IN (${placeholders})${projectFilter}
            `;
      totalParams = [...typeFilters, ...(projectId ? [projectId] : [])];

      publishedSql = `
                SELECT COUNT(*) as published_count 
                FROM report 
                WHERE is_published = true 
                AND type IN (${placeholders})${projectFilter}
            `;
      publishedParams = [...typeFilters, ...(projectId ? [projectId] : [])];

      unpublishedSql = `
                SELECT COUNT(*) as unpublished_count 
                FROM report 
                WHERE is_published = false 
                AND type IN (${placeholders})${projectFilter}
            `;
      unpublishedParams = [...typeFilters, ...(projectId ? [projectId] : [])];
    } else {
      // When no type filters, use simple queries without parameters
      let projectFilter = "";
      if (projectId) {
        projectFilter = " WHERE project_id = $1";
      }
      totalSql = `
                SELECT COUNT(*) as total_count 
                FROM report${projectFilter}
            `;
      totalParams = projectId ? [projectId] : [];

      publishedSql = `
                SELECT COUNT(*) as published_count 
                FROM report 
                WHERE is_published = true${
                  projectId ? " AND project_id = $1" : ""
                }
            `;
      publishedParams = projectId ? [projectId] : [];

      unpublishedSql = `
                SELECT COUNT(*) as unpublished_count 
                FROM report 
                WHERE is_published = false${
                  projectId ? " AND project_id = $1" : ""
                }
            `;
      unpublishedParams = projectId ? [projectId] : [];
    }

    console.log("Executing SQL:", totalSql, "with params:", totalParams);

    // Execute all queries
    const [totalResult, publishedResult, unpublishedResult] = await Promise.all(
      [
        executeQuery(totalSql, totalParams),
        executeQuery(publishedSql, publishedParams),
        executeQuery(unpublishedSql, unpublishedParams),
      ]
    );

    // Validate query results
    if (
      !totalResult?.success ||
      !totalResult?.data?.[0] ||
      !publishedResult?.success ||
      !publishedResult?.data?.[0] ||
      !unpublishedResult?.success ||
      !unpublishedResult?.data?.[0]
    ) {
      console.error("Invalid database query results:", {
        totalResult,
        publishedResult,
        unpublishedResult,
      });
      return LambdaResponse.error(
        buildError("DATABASE_ERROR", "Invalid database response")
      );
    }

    // Build response data with safe parsing - extract from data property
    const counts = {
      total: parseInt(totalResult.data[0].total_count) || 0,
      published: parseInt(publishedResult.data[0].published_count) || 0,
      unpublished: parseInt(unpublishedResult.data[0].unpublished_count) || 0,
      available_types: reportType,
      ...(typeFilters.length > 0 && {
        type_filters: typeFilters,
        type_names: typeFilters.map(
          (t) =>
            Object.keys(reportType).find((key) => reportType[key] === t) ||
            "UNKNOWN"
        ),
      }),
    };

    return LambdaResponse.success(
      new ApiResponse(true, counts, "Report counts retrieved successfully")
    );
  } catch (error) {
    console.error("Error:", error);
    return LambdaResponse.error(buildError("DATABASE_ERROR"));
  }
};
