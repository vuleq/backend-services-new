import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

const LIKE = "LIKE";

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  const name = event.queryStringParameters?.name;
  const isDeleted = event.queryStringParameters?.isDeleted === 'true' ? true : false;
  const createdBy = event.queryStringParameters?.createdBy;
  const limit = parseInt(event.queryStringParameters?.limit ?? '', 10);
  const offset = parseInt(event.queryStringParameters?.offset ?? '', 10);
  const oderBy = event.queryStringParameters?.oderBy;
  const sortBy = event.queryStringParameters?.sortBy ?? 'ASC';
  if (isNaN(limit) || limit <= 0) {
    return new LambdaResponse(400, new ApiResponse(false, null, "Invalid 'limit' query parameter. Must be a number greater than 0."));
  }
  if (isNaN(offset) || offset < 0) {
    return new LambdaResponse(400, new ApiResponse(false, null, "Invalid 'offset' query parameter. Must be a number greater or equal 0."));
  }
  try {
    let selectSql = 'SELECT * FROM trade_sections';
    let paramCount = 0;
    let selectParams: any[] = [];
    ({ paramCount, selectSql } = setParam(name, paramCount, selectSql, selectParams, 'name', LIKE));
    ({ paramCount, selectSql } = setParam(createdBy, paramCount, selectSql, selectParams, 'created_by', ""));
    ({ paramCount, selectSql } = setParam(isDeleted, paramCount, selectSql, selectParams, 'is_deleted', ""));
    if (oderBy) {
      selectSql = selectSql + ' ORDER BY ' + oderBy + ' ' + sortBy;
    }
    if (limit > 0 && offset >= 0) {
      selectSql = selectSql + ' LIMIT ' + limit + ' OFFSET ' + offset;
    }
    selectSql = selectSql + ';';
    console.log('Select SQL:', selectSql);
    console.log('Select Params:', selectParams);
    const result = await executeQuery(selectSql, selectParams);
    console.log('Result: ', result);
    return new LambdaResponse(200, new ApiResponse(true, result.data));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};

function setParam(value: any, paramCount: number, selectSql: string, selectParams: any[], paramName: string, operator: string) {
  if (value) {
    if (paramCount === 0) {
      selectSql += ' WHERE';
    } else {
      selectSql += ' AND';
    }
    paramCount++;
    if (operator === LIKE) {
      selectSql += ` ${paramName} ILIKE $${paramCount}`;
      selectParams.push(`%${value}%`);
    } else {
      selectSql += ` ${paramName} = $${paramCount}`;
      selectParams.push(value);
    }
  }
  return { paramCount, selectSql };
}
