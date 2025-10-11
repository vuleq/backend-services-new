import { executeQuery, logAPIError, logDatabaseError } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';

const roleEnum = {
  'Super User': 0,
  'SRM': 1,
  'Safety Officer': 2,
  'Commercial Officer Admin': 3,
  'Commercial Officer': 4,
  'Guest': 5
};

const projectStatus = {
  'Not started': 0,
  Started: 1,
  Completed: 2,
  Closed: 3
};

const roleNameEnum = Object.fromEntries(
  Object.entries(roleEnum).map(([name, id]) => [id, name])
);

const projectNameEnum = Object.fromEntries(
  Object.entries(projectStatus).map(([name, id]) => [id, name])
);

export const handler = async (event) => {
  console.log('Receive Event:', event);
  const id = event.pathParameters?.id;

  if (!id) {
    await logAPIError('Project id is required');
    return new LambdaResponse(400, new ApiResponse(false, null, 'Project id is required'));
  }

  try {
    // Get project with assigned users
    const sql = `
    SELECT 
        p.id,
        p.main_code,
        p.vessel_name,
        p.created_date,
        p.updated_date,
        p.owner_rep,
        p.ship_contact,
        p.vscc_meeting_time,
        p.vessel_size,
        p.arrival_date,
        p.departure_date,
        p.docking_date,
        p.undocking_date,
        p.plan_start_date,
        p.plan_complete_date,
        p.actual_start_date,
        p.actual_complete_date,
        p.remark,
        p.status,
        p.quotation_link,
        p.updated_by,
        (
          SELECT COALESCE(json_agg(json_build_object(
            'id', pa.id,
            'user_id', u.id,
            'name', u.name,
            'email', u.email,
            'role', pa.role
          ) ORDER BY u.name), '[]'::json)
          FROM project_assignments pa
          JOIN users u ON pa.user_id = u.id
          WHERE pa.project_id = p.id
        ) as assigned_users,
        (
          SELECT COALESCE(json_agg(json_build_object(
            'id', ts.id,
            'name', ts.name,
            'assigned_users', (
              SELECT COALESCE(json_agg(json_build_object(
                'id', ptsa.id,
                'user_id', u.id,
                'name', u.name,
                'email', u.email,
                'role', r.name
              ) ORDER BY u.name), '[]'::json)
              FROM project_trade_section_assigns ptsa
              JOIN users u ON ptsa.user_id = u.id
              JOIN roles r ON ptsa.role_id = r.id
              WHERE ptsa.project_trade_section_id = pts.id
            )
          ) ORDER BY ts.name), '[]'::json)
          FROM project_trade_sections pts
          JOIN trade_sections ts ON pts.trade_section_id = ts.id
          WHERE pts.project_id = p.id
        ) as assigned_trade_sections
      FROM projects p
      WHERE p.id = $1
      GROUP BY p.id
    `;
    const params = [id];
    const result = await executeQuery(sql, params);

    console.log('Select result:', result);

    if (result.error) {
      await logDatabaseError(deleteResult.error ?? 'Failed to get project');
      return new LambdaResponse(400, new ApiResponse(false, null, 'Failed to get project', result.error));
    }

    if (result.rowCount === 0) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Project not found', result.error));
    }

    result.data[0].status = projectNameEnum[result.data[0].status];

    // Convert role IDs to role names
    if (result.data[0].assigned_users) {
      result.data[0].assigned_users.forEach(user => {
        user.role = roleNameEnum[user.role] || 'Unknown';
      });
    }

    return new LambdaResponse(200, new ApiResponse(true, result.data[0], 'Project retrieved successfully'));

  } catch (error) {
    console.error('Error:', error);
    await logAPIError('Internal server error');
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error?.message || error));
  }
};