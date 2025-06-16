import { executeQuery } from '/opt/nodejs/db';
import { ApiResponse, LambdaResponse } from '/opt/nodejs/api-model';

const LIKE = "LIKE";

export const handler = async (event: any) => {
  console.log('Receive Event:', event);
  const phone = event.queryStringParameters?.phone;
  const name = event.queryStringParameters?.name;
  const mail = event.queryStringParameters?.email;
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
  let selectSql = 'SELECT * FROM users';
  let paramCount = 0;
  let selectParams: any[] = [];
  try {
    ({ paramCount, selectSql } = setParam(phone, paramCount, selectSql, selectParams, 'phone', LIKE));
    ({ paramCount, selectSql } = setParam(name, paramCount, selectSql, selectParams, 'name', LIKE));
    ({ paramCount, selectSql } = setParam(mail, paramCount, selectSql, selectParams, 'email', LIKE));
    if (oderBy) {
      selectSql = selectSql + ' ORDER BY ' + oderBy + ' ' + sortBy;
    }
    if (limit > 0 && offset >= 0) {
      selectSql = selectSql + ' LIMIT ' + limit + ' OFFSET ' + offset;
    }
    selectSql = selectSql + ';';
    console.log('Select SQL:', selectSql);
    console.log('Select Params:', selectParams);
    const selectedUsers = await executeQuery(selectSql, selectParams);
    console.log('Selected Users:', selectedUsers);
    return new LambdaResponse(200, new ApiResponse(true, selectedUsers));
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
