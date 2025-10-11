import { executeQuery } from "wdr-connect-db";
import { ApiResponse, LambdaResponse } from "wdr-models";

export const handler = async (event) => {
  console.log("Receive Event:", event);
  const id = event.pathParameters?.id;

  if (!id) {
    return LambdaResponse.error(
      new ApiResponse(false, null, "Missing id parameter")
    );
  }

  try {
    const sql = `SELECT sc.sub_no, sc.description, sc.project_id,
    ARRAY_AGG(DISTINCT jsonb_build_object('id', ts.id, 'name', ts.name, 'code', tssc.code)) as activities
    FROM sub_codes sc 
    LEFT JOIN trade_section_sub_code tssc ON tssc.sub_code_id = sc.id 
    LEFT JOIN trade_sections ts ON ts.id = tssc.trade_section_id 
    WHERE sc.id = $1
    GROUP BY sc.id, sc.sub_no, sc.description, sc.project_id;`;
    const params = [id];
    const result = await executeQuery(sql, params);

    console.log("Select result:", result);

    if (!result.success) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Database error", result.error)
      );
    }

    if (result.rowCount === 0) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Sub code not found!")
      );
    }

    return LambdaResponse.success(new ApiResponse(true, result.data[0]));
  } catch (error) {
    console.error("Error:", error);
    return LambdaResponse.error(
      new ApiResponse(false, null, "Internal server error", error.message)
    );
  }
};
