import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { isValidUUID } from 'wdr-common-utils';
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

interface PreDefinedItem {
  id: string;
  name: string;
  type: number;
  description: string | null;
  trade_section_id: string | null;
  work_category_id: string | null;
  data: any; // JSONB type
  work_category_name: string | null;
}

const definedTypeEnumName = {
  'Pre-defined text': 0,
  'Standard checklist': 1,
  'Dynamic values': 2
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Receive Event:', event);

  try {
    const tradeSectionId = event.queryStringParameters?.['trade-section-id'];

    // Validate tradeSectionId if provided
    if (tradeSectionId !== undefined && tradeSectionId !== null) {
      if (!isValidUUID(tradeSectionId)) {
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
    }

    if (conditions.length > 0) {
      selectSql += ` WHERE ${conditions.join(' AND ')} OR pd.type = ${definedTypeEnumName['Dynamic values']}`;
    }

    console.log('Query:', selectSql);
    console.log('Params:', selectParams);

    const result = await executeQuery(selectSql, selectParams);

    if (!result.success) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Database error', result.error));
    }

    const preDefinedItems = result.data.map((item: PreDefinedItem) => ({ ...item, name: (item.type === definedTypeEnumName['Dynamic values']) ? `[${item.name}]` : item.name }));
    return new LambdaResponse(200, new ApiResponse(true, preDefinedItems));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(400, new ApiResponse(false, null, 'Internal server error', error?.message || error));
  }
};