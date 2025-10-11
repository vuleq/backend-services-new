import { executeQuery } from 'wdr-connect-db';
import { LambdaResponse, ApiResponse, ResponsePage } from 'wdr-models';
import { buildError } from 'wdr-error-codes';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(dateStr) {
    if (!dateRegex.test(dateStr)) return false;
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
    );
}

export const handler = async (event) => {
    try {
        console.log('=== User Login History Get All Lambda Started ===');
        console.log('Event:', JSON.stringify(event, null, 2));

        const pageNumber = parseInt(event?.queryStringParameters?.pageNumber || '1', 10);
        const pageSize = parseInt(event?.queryStringParameters?.pageSize || '10', 10);

        let startDate = event?.queryStringParameters?.startDate || null;
        let endDate = event?.queryStringParameters?.endDate || null;
        const email = event?.queryStringParameters?.email || null;
        const userName = event?.queryStringParameters?.user_name || null;

        if (startDate && !isValidDate(startDate)) {
            return LambdaResponse.error(
                buildError('INVALID_DATE', 'startDate must be a valid date in format yyyy-mm-dd'), 400
            );
        }
        if (endDate && !isValidDate(endDate)) {
            return LambdaResponse.error(
                buildError('INVALID_DATE', 'endDate must be a valid date in format yyyy-mm-dd'), 400
            );
        }

        if (endDate) {
            const endDateObj = new Date(endDate);
            endDateObj.setDate(endDateObj.getDate() + 1);
            endDate = endDateObj.toISOString().split('T')[0];
        }

        let whereClause = `WHERE 1=1`;
        const params = [];
        let paramIndex = 1;

        if (startDate) {
            whereClause += ` AND login_time >= $${paramIndex++}`;
            params.push(startDate);
        } else {
            whereClause += ` AND login_time >= (SELECT MIN(login_time) FROM user_login_history)`;
        }

        if (endDate) {
            whereClause += ` AND login_time < $${paramIndex++}`;
            params.push(endDate);
        } else {
            whereClause += ` AND login_time <= (SELECT MAX(login_time) FROM user_login_history)`;
        }

        if (email) {
            whereClause += ` AND email ILIKE $${paramIndex++}`;
            params.push(`%${email}%`);
        }

        if (userName) {
            whereClause += ` AND user_name ILIKE $${paramIndex++}`;
            params.push(`%${userName}%`);
        }

        // Query count
        const countQuery = `
            SELECT COUNT(*) AS total
            FROM user_login_history
            ${whereClause}
        `;
        const countResult = await executeQuery(countQuery, params);
        const totalCount = parseInt(countResult.data[0]?.total || '0', 10);

        // Query data
        const dataQuery = `
            SELECT id, user_name, login_time, email
            FROM user_login_history
            ${whereClause}
            ORDER BY login_time DESC
            LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `;
        const offset = (pageNumber - 1) * pageSize;
        const dataResult = await executeQuery(dataQuery, [...params, pageSize, offset]);

        const page = new ResponsePage(pageNumber, pageSize, totalCount, dataResult.data);

        return LambdaResponse.success(new ApiResponse(true, page));

    } catch (err) {
        console.error('Error fetching login history:', err);
        return LambdaResponse.error(
            buildError('DATABASE_ERROR', 'Error occurred while fetching login history')
        );
    }
};
