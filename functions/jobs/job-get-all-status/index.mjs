import { LambdaResponse, ApiResponse } from "wdr-models";
import { executeQuery } from 'wdr-connect-db';

const jobStatus = {
  Draft: 0,
  Confirmed: 1,
  Cancelled: 2,
  Started: 3,
  Completed: 4
}

const WDRStatus = {
  'Not started': 0,
  Draft: 1,
  'Pre review': 2,
  'HOD review': 3,
  'SRM review': 4,
  Completed: 5
}

export const handler = async (event) => {
  try {
    return new LambdaResponse(200, new ApiResponse(true, { status: jobStatus, wdr_status: WDRStatus }));
  } catch (error) {
    console.error('Error:', error);
    return new LambdaResponse(400, ApiResponse(false, null, 'Internal server error', error.message));
  }
};