import { deleteRecord, executeQuery } from "wdr-connect-db";
import { ApiResponse, LambdaResponse } from "wdr-models";

export const handler = async (event) => {
  console.log("Receive Event:", event);

  const { id } = event.pathParameters || {};

  if (!id) {
    return LambdaResponse.error(
      new ApiResponse(false, null, "Trade section id is required", null)
    );
  }

  try {
    // Combined query: get trade section data and usage counts
    const combinedSql = `
      SELECT 
        s.*,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', wc.id,
              'name', wc.name
            )
          ) FILTER (WHERE wc.id IS NOT NULL), 
          '[]'::json
        ) as work_categories,
        EXISTS(SELECT 1 FROM pre_defined WHERE trade_section_id = s.id) as has_pre_defined,
        EXISTS(SELECT 1 FROM project_trade_sections WHERE trade_section_id = s.id) as has_projects,
        EXISTS(SELECT 1 FROM trade_section_sub_code WHERE trade_section_id = s.id) as has_sub_codes,
        EXISTS(SELECT 1 FROM user_trade_sections WHERE trade_section_id = s.id) as has_users
      FROM trade_sections s 
      LEFT JOIN work_categories wc ON s.id = wc.trade_section_id 
      WHERE s.id = $1
      GROUP BY s.id`;

    const result = await executeQuery(combinedSql, [id]);

    if (!result.success) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          `Error when get trade section data: ${result.error}`
        )
      );
    }

    if (result.rowCount === 0) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Trade section not found!")
      );
    }

    const {
      has_pre_defined,
      has_projects,
      has_sub_codes,
      has_users,
      work_categories,
    } = result.data[0];

    if (has_pre_defined) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          "Cannot delete trade section: it is used in pre-defined texts"
        )
      );
    }

    if (has_projects) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          "Cannot delete trade section: it is used in projects"
        )
      );
    }

    if (has_sub_codes) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          "Cannot delete trade section: it is used in sub code (WBS)"
        )
      );
    }

    if (has_users) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          "Cannot delete trade section: user assigned to trade section"
        )
      );
    }

    if (work_categories && work_categories.length > 0) {
      await deleteRecord("work_categories", { trade_section_id: id });
    }

    const deleteResult = await deleteRecord("trade_sections", { id: id });
    console.log("Delete result:", deleteResult);

    if (!deleteResult.success) {
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          "Trade section not found or already deleted!",
          deleteResult.error
        )
      );
    }

    return LambdaResponse.success(
      new ApiResponse(true, null, "Trade section deleted successfully")
    );
  } catch (error) {
    console.error("Error:", error);
    return LambdaResponse.error(
      new ApiResponse(false, null, "Internal server error", error.message)
    );
  }
};
