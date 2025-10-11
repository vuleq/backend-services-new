import { executeQuery, logAPIError, logDatabaseError } from "wdr-connect-db";
import { ApiResponse, LambdaResponse } from "wdr-models";

export const handler = async (event) => {
  console.log("Receive Event:", event);
  const { id } = event.pathParameters || {};

  if (!id) {
    await logAPIError("Missing trade section id");
    return LambdaResponse.error(
      new ApiResponse(false, null, "Trade section id is required", null)
    );
  }

  try {
    const sql = `
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
        ) as work_categories
      FROM trade_sections s 
      LEFT JOIN work_categories wc ON s.id = wc.trade_section_id 
      WHERE s.id = $1
      GROUP BY s.id`;

    const params = [id];
    const result = await executeQuery(sql, params);

    console.log("Select result:", result);

    if (!result.success) {
      await logDatabaseError(`Error when get trade section data`);
      return LambdaResponse.error(
        new ApiResponse(
          false,
          null,
          `Error when get trade section data: ${result.error}`
        )
      );
    }

    if (result.rowCount === 0) {
      await logDatabaseError(`Trade section not found`);
      return LambdaResponse.error(
        new ApiResponse(false, null, "Trade section not found!")
      );
    }

    return LambdaResponse.success(new ApiResponse(true, result.data));
  } catch (error) {
    console.error("Error:", error);
    await logAPIError("Internal server error");
    return LambdaResponse.error(
      new ApiResponse(false, null, "Internal server error", error.message)
    );
  }
};
