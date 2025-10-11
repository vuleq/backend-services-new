import { executeQuery, logAPIError, logDatabaseError } from 'wdr-connect-db';
import { LambdaResponse, ApiResponse } from 'wdr-models';
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

const TYPE_OF_REPORT = 3

export const handler = async (event) => {
    try {
        console.log('=== Count All Report Lambda Started ===');
        console.log('Event:', JSON.stringify(event, null, 2));

        let startDate = event?.queryStringParameters?.startDate || null;
        let endDate = event?.queryStringParameters?.endDate || null;


        if (startDate && !isValidDate(startDate)) {
            await logAPIError('Invalid startDate format');
            return LambdaResponse.error(
                buildError('INVALID_DATE', 'startDate must be a valid date in format yyyy-mm-dd'), 400
            );
        }
        if (endDate && !isValidDate(endDate)) {
            await logAPIError('Invalid endDate format');
            return LambdaResponse.error(
                buildError('INVALID_DATE', 'endDate must be a valid date in format yyyy-mm-dd'), 400
            );
        }

        if (endDate) {
            const endDateObj = new Date(endDate);
            endDateObj.setDate(endDateObj.getDate() + 1);
            endDate = endDateObj.toISOString().split('T')[0];
        }

        let whereClause = `WHERE type = ${TYPE_OF_REPORT}`;
        const params = [];
        let paramIndex = 1;

        if (startDate) {
            whereClause += ` AND created_at >= $${paramIndex++}`;
            params.push(startDate);
        } else {
            whereClause += ` AND created_at >= (SELECT MIN(created_at) FROM report)`;
        }

        if (endDate) {
            whereClause += ` AND created_at < $${paramIndex++}`;
            params.push(endDate);
        } else {
            whereClause += ` AND created_at <= (SELECT MAX(created_at) FROM report)`;
        }

        // Query count
        const countQuery = `
            SELECT COUNT(*) AS total
            FROM report
            ${whereClause}
        `;
        const countResult = await executeQuery(countQuery, params);
        const totalCount = parseInt(countResult.data[0]?.total || '0', 10);


        return LambdaResponse.success(new ApiResponse(true, {totalReport: totalCount}));

    } catch (err) {
        console.error('Error fetching login history:', err);
        await logDatabaseError('Error occurred while fetching login history');
        return LambdaResponse.error(
            buildError('DATABASE_ERROR', 'Error occurred while fetching login history')
        );
    }
};
