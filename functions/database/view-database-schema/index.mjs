import { executeQuery, performTransaction } from 'wdr-connect-db';
import { LambdaResponse, ApiResponse } from 'wdr-models';
import { buildError } from 'wdr-error-codes';

export const handler = async (event) => {
    try {
        console.log('=== Database Import Lambda Started ===');
        console.log('Event:', JSON.stringify(event, null, 2));

        // Optional: Get tableName from query parameters
        const tableName = event?.queryStringParameters?.tableName || null;

        let query = `
            SELECT 
                table_name,
                column_name,
                data_type,
                is_nullable,
                character_maximum_length
            FROM information_schema.columns
            WHERE table_schema = 'public'
        `;

        const params = [];
        if (tableName) {
            query += ` AND table_name = $1`;
            params.push(tableName);
        }
        console.log(query)
        const res = await executeQuery(query, params)
        console.log("res", res)

        const schema = {};
        for (const row of res.data) {
            const { table_name, ...column } = row;
            if (!schema[table_name]) {
                schema[table_name] = [];
            }
            schema[table_name].push(column);
        }

        console.log('Retrieved schema:', JSON.stringify(schema, null, 2));

        return LambdaResponse.success(new ApiResponse(true, schema, 'Database schema retrieved successfully'));
    } catch (err) {
        console.error('Error during database schema fetch:', err);
        return LambdaResponse.error(buildError('DATABASE_ERROR', 'An error occurred while updating the project'));
    }
};