import { updateRecord, executeQuery } from '/opt/nodejs/db';
import { LambdaResponse, ApiResponse } from '/opt/nodejs/api-model';

// Define allowed project status and type for request body
const projectStatus = {
  'Not Start': 0,
  Started: 1,
  Completed: 2,
  Closed: 3
} as const;

type ProjectStatusKey = keyof typeof projectStatus;

interface ProjectUpdateBody {
  ownerRep?: string;
  shipContact?: string;
  projectManager?: string;
  safetyOfficer?: string;
  commercialOfficer?: string;
  vsccMeetingTime?: string;
  vesselSize?: string;
  arrivalDate?: string;
  departureDate?: string;
  dockingDate?: string;
  undockingDate?: string;
  planStartDate?: string;
  planCompleteDate?: string;
  actualStartDate?: string;
  actualCompleteDate?: string;
  remark?: string;
  status?: ProjectStatusKey;
}

export const handler = async (event: any) => {
  console.log('Receive Event:', event);

  // Parse and validate request body
  let body: ProjectUpdateBody = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid JSON in request body'));
  }

  // Extract and validate project ID
  const projectId = event?.pathParameters?.id;
  console.log('Project Id:', projectId);

  if (!projectId) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Project ID is required'));
  }

  if (!body || Object.keys(body).length === 0) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Request body is required'));
  }

  // Sanitize string inputs
  Object.keys(body).forEach(key => {
    const value = (body as any)[key];
    if (typeof value === 'string') {
      (body as any)[key] = value.trim();
    }
  });

  // Validate status
  if (body.status && !(body.status in projectStatus)) {
    return new LambdaResponse(400, new ApiResponse(false, null, `Invalid status value. Allowed: ${Object.keys(projectStatus).join(', ')}`));
  }

  try {
    // Validate individual date formats
    validateDate(body.arrivalDate, 'arrivalDate');
    validateDate(body.departureDate, 'departureDate');
    validateDate(body.dockingDate, 'dockingDate');
    validateDate(body.undockingDate, 'undockingDate');
    validateDate(body.planStartDate, 'planStartDate');
    validateDate(body.planCompleteDate, 'planCompleteDate');
    validateDate(body.actualStartDate, 'actualStartDate');
    validateDate(body.actualCompleteDate, 'actualCompleteDate');
    
    // Validate date ranges
    if (body.arrivalDate && body.departureDate && !isValidDate(body.arrivalDate, body.departureDate)) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Arrival date cannot be after departure date'));
    }
    
    if (body.dockingDate && body.undockingDate && !isValidDate(body.dockingDate, body.undockingDate)) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Docking date cannot be after undocking date'));
    }
    
    if (body.planStartDate && body.planCompleteDate && !isValidDate(body.planStartDate, body.planCompleteDate)) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Plan start date cannot be after plan complete date'));
    }
    
    if (body.actualStartDate && body.actualCompleteDate && !isValidDate(body.actualStartDate, body.actualCompleteDate)) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Actual start date cannot be after actual complete date'));
    }

    const sql = 'SELECT * FROM projects WHERE id = $1;';
    const params = [projectId];
    const result = await executeQuery(sql, params);
    console.log('Select result:', result);

    if (result.error) {
      return new LambdaResponse(500, new ApiResponse(false, null, 'Database error', result.error));
    }
    
    if (!result.data || result.data.length === 0) {
      return new LambdaResponse(404, new ApiResponse(false, null, 'Project not found!'));
    }

    if (result.data[0].status === projectStatus['Closed']) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'Cannot update a closed project'));
    }
  } catch (error: any) {
    return new LambdaResponse(400, new ApiResponse(false, null, error.message));
  }

  try {
    // Build data object with column names as keys
    const projectData: Record<string, any> = {
      owner_rep: body.ownerRep,
      ship_contact: body.shipContact,
      project_manager: body.projectManager,
      safety_officer: body.safetyOfficer,
      commercial_officer: body.commercialOfficer,
      vscc_meeting_time: body.vsccMeetingTime,
      vessel_size: body.vesselSize,
      arrival_date: body.arrivalDate,
      departure_date: body.departureDate,
      docking_date: body.dockingDate,
      undocking_date: body.undockingDate,
      plan_start_date: body.planStartDate,
      plan_complete_date: body.planCompleteDate,
      actual_start_date: body.actualStartDate,
      actual_complete_date: body.actualCompleteDate,
      remark: body.remark,
      status: body.status ? projectStatus[body.status] : undefined,
      update_date: new Date().toISOString()
    };

    // Remove undefined fields
    Object.keys(projectData).forEach(key => {
      if (projectData[key] === undefined) {
        delete projectData[key];
      }
    });

    console.log('Project Data:', projectData);

    const result = await updateRecord('projects', projectData, { id: projectId });
    console.log('Result:', result);

    if (result.success) {
      return new LambdaResponse(200, new ApiResponse(true, result.data[0], 'Project updated successfully'));
    }
    return new LambdaResponse(400, new ApiResponse(false, null, 'Project update failed', result.error));
  } catch (error: any) {
    console.error('Error:', error);
    return new LambdaResponse(500, new ApiResponse(false, null, 'Internal server error', error.message));
  }
};

const isValidDate = (start: string, end: string): boolean => {
  const startDate = new Date(start);
  const endDate = new Date(end);
  return startDate <= endDate;
};

// Validate date fields
const validateDate = (dateField: string | undefined, fieldName: string): boolean => {
  if (dateField && isNaN(Date.parse(dateField))) {
    throw new Error(`Invalid ${fieldName} format. Use YYYY-MM-DD format.`);
  }
  return true;
};
