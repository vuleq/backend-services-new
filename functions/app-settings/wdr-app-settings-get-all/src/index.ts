import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { LambdaResponse, ApiResponse } from 'wdr-models';
import { buildError } from 'wdr-error-codes';

interface AppSetting {
  id: number;
  group_code: string;
  code: string;
  name: string;
  description: string;
  value: string;
  unit: string;
}

// Cho phép sort theo các cột này thôi để tránh SQL Injection
const ALLOWED_SORT_COLUMNS = ['group_code', 'code', 'name', 'value', 'unit'];
const ALLOWED_SORT_ORDER = ['asc', 'desc'];

export const handler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
      console.log('=== App Settings Get All Lambda Started ===');
      console.log('Event:', JSON.stringify(event, null, 2));

      const filters = event?.queryStringParameters || {};

      let query = `
        SELECT id, group_code, code, name, description, value, unit
        FROM app_settings
        WHERE 1=1
      `;
      const params: (string | number)[] = [];
      let paramIndex = 1;

      // Thêm filter động
      if (filters.group_code) {
        query += ` AND group_code = $${paramIndex++}`;
        params.push(filters.group_code);
      }
      if (filters.code) {
        query += ` AND code = $${paramIndex++}`;
        params.push(filters.code);
      }
      if (filters.name) {
        query += ` AND name ILIKE $${paramIndex++}`;
        params.push(`%${filters.name}%`);
      }
      if (filters.value) {
        query += ` AND value = $${paramIndex++}`;
        params.push(filters.value);
      }

      // Sort
      let sortBy = filters.sort_by || 'group_code';
      let sortOrder = filters.sort_order || 'asc';

      if (!ALLOWED_SORT_COLUMNS.includes(sortBy)) {
        sortBy = 'group_code';
      }
      if (!ALLOWED_SORT_ORDER.includes(sortOrder.toLowerCase())) {
        sortOrder = 'asc';
      }

      query += ` ORDER BY ${sortBy} ${sortOrder.toUpperCase()}`;

      const result = await executeQuery(query, params);

      return LambdaResponse.success(
        new ApiResponse(true, result.data, 'Settings retrieved successfully')
      );
    } catch (err) {
      console.error('Error fetching settings:', err);
      return LambdaResponse.error(
        buildError('DATABASE_ERROR', 'Error occurred while fetching settings')
      );
    }
  };
