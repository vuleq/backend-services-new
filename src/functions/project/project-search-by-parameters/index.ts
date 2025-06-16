import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

const LIKE = "LIKE";
const statusEnum = Object.freeze({
  NEW: 0,
  IN_PROGRESS: 1,
  COMPLETE: 2
});

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  const code = event.queryStringParameters?.code;
  const status = event.queryStringParameters?.status;
  const createDate = event.queryStringParameters?.createDate;
  const projectManager = event.queryStringParameters?.projectManager;
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
    let selectSql = 'SELECT * FROM projects';
    let paramCount = 0;
    let selectParams: any[] = [];
    ({ paramCount, selectSql } = setParam(code, paramCount, selectSql, selectParams, 'main_code', LIKE));
    ({ paramCount, selectSql } = setParam(status, paramCount, selectSql, selectParams, 'status', ""));
    ({ paramCount, selectSql } = setParam(createDate, paramCount, selectSql, selectParams, 'create_date', ""));
    ({ paramCount, selectSql } = setParam(projectManager, paramCount, selectSql, selectParams, 'project_manager', ""));
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
