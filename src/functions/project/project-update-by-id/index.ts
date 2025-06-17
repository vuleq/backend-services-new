import { updateRecord } from '/opt/nodejs/db';
import { LambdaResponse, ApiResponse } from '/opt/nodejs/api-model';

const projectStatus = {
  'Not Start': 0,
  Started: 1,
  Completed: 2,
  Closed: 3
};

export const handler = async (event: any) => {
  console.log('Receive Event:', event);

  const body = JSON.parse(event.body) || {};
  const projectId = event?.pathParameters?.id;

  console.log('Project Id:', projectId);

  if (!projectId) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Project ID is required'));
  }

  if (!body || Object.keys(body).length === 0) {
    return new LambdaResponse(400, new ApiResponse(false, null, 'Request body is required'));
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
      status: projectStatus[body.status as keyof typeof projectStatus],
      update_date: new Date().toISOString()
    };

    console.log('Project Data:', projectData);

    const result = await updateRecord('projects', projectData, { id: projectId});

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
