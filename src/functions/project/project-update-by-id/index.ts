import { updateRecord } from '/opt/nodejs/db';
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

  let body: ProjectUpdateBody = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid JSON in request body'));
  }

  const projectId = event?.pathParameters?.id;
  console.log('Project Id:', projectId);

  if (!projectId) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Project ID is required'));
  }

  if (!body || Object.keys(body).length === 0) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Request body is required'));
  }

  // Validate status
  if (body.status && !(body.status in projectStatus)) {
    return new LambdaResponse(400, new ApiResponse(false, null, `Invalid status value. Allowed: ${Object.keys(projectStatus).join(', ')}`));
  }

  // validate date fields
  if (body.arrivalDate && isNaN(Date.parse(body.arrivalDate))) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid arrivalDate format'));
  }

  if (body.departureDate && isNaN(Date.parse(body.departureDate))) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid departureDate format'));
  }

  if (body.dockingDate && isNaN(Date.parse(body.dockingDate))) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid dockingDate format'));
  }

  if (body.undockingDate && isNaN(Date.parse(body.undockingDate))) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid undockingDate format'));
  }

  if (body.planStartDate && isNaN(Date.parse(body.planStartDate))) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid planStartDate format'));
  }

  if (body.planCompleteDate && isNaN(Date.parse(body.planCompleteDate))) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid planCompleteDate format'));
  }

  if (body.actualStartDate && isNaN(Date.parse(body.actualStartDate))) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid actualStartDate format'));
  }

  if (body.actualCompleteDate && isNaN(Date.parse(body.actualCompleteDate))) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid actualCompleteDate format'));
  }

  try {
    // Build data object with column names as keys
    const projectData = {
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
    Object.keys(projectData).forEach(key => (projectData as any)[key] === undefined && delete (projectData as any)[key]);

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
