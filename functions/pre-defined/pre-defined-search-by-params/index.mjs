import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

const definedTypeEnum = {
  'Pre-defined text': 0,
  'Standard checklist': 1,
  'Dynamic values': 2
}

function getArrayParamFromMultiValueOrQuery(multiValueParams, queryParams, key) {
  if (multiValueParams[key] && multiValueParams[key].length > 0) {
    return multiValueParams[key];
  }
  return queryParams[key] ? [queryParams[key]] : [];
}

export const handler = async (event) => {
  console.log('Receive Event:', event);

  try {
    const queryParams = event.queryStringParameters || {};
    const multiValueParams = event.multiValueQueryStringParameters || {};

    const searchString = queryParams['search-text'];
    const tradeSections = getArrayParamFromMultiValueOrQuery(multiValueParams, queryParams, 'trade-sections');
    const offset = queryParams['page-number'];
    const orderBy = queryParams['order-by'];
    const limit = queryParams['page-size'];
    const type = queryParams['type'];

    if (!type) {
      return new ApiResponse(false, null, 'Type is required');
    }

    // Build WHERE clause based on provided filters
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    const sortOrder = orderBy?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    // Paste pagination
    const limitNum = parseInt(limit, 10) || 10;
    const offsetNum = parseInt(offset, 10) || 0;

    // Build the unified query with count
    let query = `
      WITH text_content AS (
        SELECT 
          pd.id,
          pd.name,
          pd.description,
          pd.trade_section_id,
          pd.work_category_id,
          pd.updated_by,
          pd.updated_at,
          pd.type,
          CASE WHEN pd.type = ${definedTypeEnum['Dynamic values']} 
            THEN NULL 
            ELSE COALESCE(STRING_AGG(elem->>'text', ' '), '') 
          END as extracted_text
        FROM pre_defined pd
        LEFT JOIN LATERAL JSONB_PATH_QUERY(pd.data, '$.** ? (@.type == "text")') as elem ON pd.type != ${definedTypeEnum['Dynamic values']}
        WHERE pd.type = $${paramIndex++}
        GROUP BY pd.id, pd.name, pd.description, pd.trade_section_id, pd.work_category_id, pd.updated_by, pd.updated_at, pd.type
      )
      SELECT 
        tc.id,
        tc.type,
        CASE WHEN tc.type = ${definedTypeEnum['Dynamic values']} THEN NULL ELSE ts.name END as trade_section_name,
        CASE WHEN tc.type = ${definedTypeEnum['Dynamic values']} THEN NULL ELSE wc.name END as work_category_name,
        tc.name as pre_defined_name,
        tc.description,
        CASE 
          WHEN tc.type = ${definedTypeEnum['Dynamic values']} THEN NULL
          WHEN tc.updated_by = '00000000-0000-0000-0000-000000000000' THEN 'PaxOcean Admin'
          ELSE COALESCE(u.name, tc.updated_by::text)
        END as updated_by,
        tc.updated_at as updated_time,
        tc.extracted_text as data_text,
        COUNT(*) OVER() as total_count 
      FROM text_content tc
      LEFT JOIN trade_sections ts ON ts.id = tc.trade_section_id AND tc.type != ${definedTypeEnum['Dynamic values']}
      LEFT JOIN work_categories wc ON wc.id = tc.work_category_id AND tc.type != ${definedTypeEnum['Dynamic values']}
      LEFT JOIN users u ON u.id = tc.updated_by AND tc.type != ${definedTypeEnum['Dynamic values']}`;

    params.push(parseInt(type, 10));

    if (searchString) {
      const searchPattern = `%${searchString}%`;
      conditions.push(`(
        tc.name ILIKE $${paramIndex++} OR 
        CASE WHEN tc.type = ${definedTypeEnum['Dynamic values']} 
          THEN tc.description ILIKE $${paramIndex++} 
          ELSE tc.extracted_text ILIKE $${paramIndex++} 
        END
      )`);
      params.push(searchPattern, searchPattern, searchPattern);
    }

    if (tradeSections && Array.isArray(tradeSections) && tradeSections.length > 0) {
      conditions.push(`(tc.type = ${definedTypeEnum['Dynamic values']} OR tc.trade_section_id = ANY($${paramIndex++}))`);
      params.push(tradeSections);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    // Group by trade section name and sort by trade section name, then predefined name
    query += ` ORDER BY trade_section_name NULLS LAST, pre_defined_name ${sortOrder}`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limitNum, offsetNum * limitNum);

    console.log('Query: ', query);
    console.log('Params: ', params);

    // Execute query
    const result = await executeQuery(query, params);
    console.log('Result: ', result);

    if (!result.success) {
      return new LambdaResponse(500, new ApiResponse(false, null, 'Error executing query'));
    }

    // Map result data to response format and get total count from first row
    const total = result.data.length > 0 ? parseInt(result.data[0].total_count) || 0 : 0;

    const responseData = result.data.map(item => ({
      id: item.id,
      trade_section_name: item.trade_section_name,
      work_category_name: item.work_category_name,
      name: item.pre_defined_name,
      updated_by: item.updated_by,
      updated_time: item.updated_time,
      description: item.description
    }));

    return new LambdaResponse(200, new ApiResponse(true, { pageNumber: offsetNum, pageSize: limitNum, totalCount: total, data: responseData }));
  } catch (error) {
    console.error('Error:', error);
    return new LambdaResponse(400, new ApiResponse(false, null, 'Internal server error'));
  }
};