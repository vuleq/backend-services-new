import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, ResponsePage, LambdaResponse} from 'wdr-models';
import { ERROR_CODES, buildError } from 'wdr-error-codes';

// Whitelist of columns that are safe to order by.
const ALLOWED_ORDER_BY_COLUMNS = ['name', 'email', 'phone', 'created_at', 'updated_at', 'family_name', 'given_name'];

export const handler = async (event) => {
  console.log('Receive Event:', event);

  // 1. Extract and Validate Parameters
  const { phone, name, email } = event.queryStringParameters ?? {};
  const limit = parseInt(event.queryStringParameters?.limit ?? '10', 10);
  const offset = parseInt(event.queryStringParameters?.offset ?? '0', 10);
  const orderBy = event.queryStringParameters?.orderBy;
  const sortDirection = event.queryStringParameters?.sortBy?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  if (isNaN(limit) || limit <= 0) {
    return LambdaResponse.error(buildError('INVALID_REQUEST', "Invalid 'limit' query parameter. Must be a number greater than 0."));
  }
  if (isNaN(offset) || offset < 0) {
    return LambdaResponse.error(buildError('INVALID_REQUEST', "Invalid 'offset' query parameter. Must be a number greater or equal to 0."));
  }

  // 2. Build Query Conditions and Parameters
  const queryParams = [];
  const whereConditions = [];

  // Helper for simple, single-field "AND" conditions
  const addSimpleAndCondition = (value, columnName) => {
    if (value) {
      whereConditions.push(`${columnName} ILIKE '%' || $${queryParams.length + 1} || '%'`);
      queryParams.push(value);
    }
  };

  // Use the helper for phone and email
  addSimpleAndCondition(phone, 'phone');
  addSimpleAndCondition(email, 'email');

  // **Special handling for the combined name search**
  // If a 'name' is provided, search it across multiple name-related fields.
  if (name) {
    const nameParamIndex = queryParams.length + 1;
    // Create a single condition group with OR
    const nameClause = `(family_name ILIKE '%' || $${nameParamIndex} || '%' OR given_name ILIKE '%' || $${nameParamIndex} || '%' OR middle_name ILIKE '%' || $${nameParamIndex} || '%')`;
    
    whereConditions.push(nameClause);
    queryParams.push(name); // Add the name value to the parameters array only once
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // 3. Construct Final SQL Queries
  let countSql = `SELECT COUNT(*) as total FROM users ${whereClause};`;
  
  let orderByClause = '';
  if (orderBy && ALLOWED_ORDER_BY_COLUMNS.includes(orderBy)) {
    orderByClause = `ORDER BY ${orderBy} ${sortDirection}`;
  }

  let selectSql = `
    SELECT *, family_name, given_name, middle_name FROM users
    ${whereClause} 
    ${orderByClause} 
    LIMIT $${queryParams.length + 1} 
    OFFSET $${queryParams.length + 2};
  `;
  
  const selectParams = [...queryParams, limit, offset];
  const countParams = [...queryParams];

  console.log('Select SQL:', selectSql);
  console.log('Select Params:', selectParams);
  console.log('Count SQL:', countSql);
  console.log('Count Params:', countParams);

  // 4. Execute Queries (No changes below this line)
  try {
    const [selectedUsersResult, totalCountResult] = await Promise.all([
      executeQuery(selectSql, selectParams),
      executeQuery(countSql, countParams)
    ]);

    if (!selectedUsersResult.success) {
      return LambdaResponse.error(buildError('DATABASE_ERROR', selectedUsersResult.error));
    }
    if (!totalCountResult.success) {
      return LambdaResponse.error(buildError('DATABASE_ERROR', totalCountResult.error));
    }

    const totalCount = parseInt(totalCountResult.data[0]?.total ?? '0', 10);

    const users = selectedUsersResult.data.map(user => ({
      ...user,
      full_name: combineFullName(user) // Combine names into full_name
    }));

    return new LambdaResponse(200,new ApiResponse(true, new ResponsePage(offset + 1, limit, totalCount, users)));

  } catch (error) {
    console.error('Error executing query:', error);
    return LambdaResponse.error(buildError('DATABASE_ERROR', error.message));
  }
};

const combineFullName = (user) => {
    if (!user) return '';
    const names = [user.given_name, user.middle_name, user.family_name]
        .filter(name => name && name.trim() !== '');
    return names.join(' ');
}