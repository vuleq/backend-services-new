import { executeQuery, logAPIError, logDatabaseError } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

const definedTypeEnumName = {
  'Pre-defined text': 0,
  'Standard checklist': 1,
  'Dynamic values': 2
}

export const handler = async (event) => {
  console.log('Receive Event:', event);

  try {
    const tradeSectionId = event.queryStringParameters?.['trade-section-id'];
    const type = event.queryStringParameters?.['type'];

    // Validate tradeSectionId if provided
    if (tradeSectionId !== undefined && tradeSectionId !== null) {
      if (!isValidUUID(tradeSectionId)) {
        await logAPIError('trade-section-id is not valid');
        return new LambdaResponse(400, new ApiResponse(false, null, 'trade-section-id is not valid'));
      }
    }

    let selectSql = `
      SELECT 
        pd.id, 
        pd.name, 
        pd.type,
        pd.description,
        pd.trade_section_id, 
        pd.work_category_id, 
        pd.data,
        CASE WHEN wc.id IS NOT NULL THEN wc.name ELSE NULL END as work_category_name
      FROM pre_defined pd
      LEFT JOIN work_categories wc ON pd.work_category_id = wc.id`;

    let selectParams = [];
    const conditions = [];

    if (tradeSectionId) {
      conditions.push(`pd.trade_section_id = $${selectParams.length + 1}`);
      selectParams.push(tradeSectionId);
      // Always include Dynamic values when filtering by trade section
      conditions.push(`pd.type = $${selectParams.length + 1}`);
      selectParams.push(definedTypeEnumName['Dynamic values']);
    } else if (type !== undefined && type !== null) {
      const typeNum = parseInt(type);
      if (isNaN(typeNum) || typeNum < 0 || typeNum > 2) {
        await logAPIError('type parameter must be 0, 1, or 2');
        return new LambdaResponse(400, new ApiResponse(false, null, 'type parameter must be 0, 1, or 2'));
      }
      conditions.push(`pd.type = $${selectParams.length + 1}`);
      selectParams.push(typeNum);
    }

    if (conditions.length > 0) {
      selectSql += ` WHERE ${conditions.join(tradeSectionId ? ' OR ' : ' AND ')}`;
    }

    console.log('Query:', selectSql);
    console.log('Params:', selectParams);

    const result = await executeQuery(selectSql, selectParams);

    if (!result.success) {
      await logDatabaseError('Unexpected database error');
      return new LambdaResponse(400, new ApiResponse(false, null, 'Database error', result.error));
    }

    const preDefinedItems = result.data.map(item => ({ ...item, name: (item.type === definedTypeEnumName['Dynamic values']) ? `[${item.name}]` : item.name }));
    return new LambdaResponse(200, new ApiResponse(true, preDefinedItems));
  } catch (error) {
    console.error('Error:', error);
    await logAPIError('Internal server error');
    return new LambdaResponse(400, new ApiResponse(false, null, 'Internal server error', error?.message || error));
  }
};

function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}