import { ApiResponse, LambdaResponse } from 'wdr-models';
import { executeQuery, logAPIError, logDatabaseError } from 'wdr-connect-db';

const projectStatus = {
  'Not started': 0,
  Started: 1,
  Completed: 2,
  Closed: 3
};

export const handler = async (event) => {
  try {
    const selectSql = `SELECT 
      status,
      COUNT(*) as count
    FROM projects 
    GROUP BY status
    ORDER BY status`;
    
    const result = await executeQuery(selectSql, []);
    
    if (!result.success) {
      await logDatabaseError('Failed to fetch project statuses');
      return new LambdaResponse(400, new ApiResponse(false, null, 'Failed to get project', result.error));
    }
    
    const statusCounts = {
      'Not started': 0,
      'Started': 0,
      'Completed': 0,
      'Closed': 0
    };
    
    result.data.forEach(row => {
      const statusName = Object.keys(projectStatus).find(key => projectStatus[key] === row.status);
      if (statusName) {
        statusCounts[statusName] = parseInt(row.count);
      }
    });
    return new LambdaResponse(200, new ApiResponse(true, statusCounts, 'Project status retrieved successfully'));
  } catch (error) {
    console.error('Error:', error);
    await logAPIError('Internal server error');
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error?.message || error));
  }
};