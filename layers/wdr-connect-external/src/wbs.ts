import { httpPost, getSAPHeaders } from './connect';

// SAP response
interface GetWBSResponse {
  array: WBSData[];
  status: number;
  total_count: number;
}

interface CreateWBSResponse {
  data: WBSCreateData;
  status: number;
}

// Output data
export interface WBSGetDataResult {
  success: boolean;
  data: WBSData[];
  error: string;
}

interface WBSData {
  wbs_element: string;
  wbs_element_desc: string;
  srm: string;
}

export interface WBSCreateDataResult {
  success: boolean;
  data: WBSCreateData | null;
  error: string;
}

interface WBSCreateData {
  wbs_element: string;
  wbs_element_desc: string;
  project_code: string;
}

// Status code
const WBSStatusCode = {
  SUCCESS: { code: 7000, message: 'Success to get WBS' },
  NO_WBS: { code: 7001, message: 'No WBS found' },
  FAILED: { code: 7002, message: 'Failed to get WBS' }
};

const WBSCreateStatusCode = {
  CREATE_SUCCESS: { code: 7100, message: 'Success to create WBS' },
  DUPLICATE_WBS: { code: 7102, message: 'Duplicate WBS No' },
  CREATE_FAILED: { code: 7103, message: 'Fail to create WBS' }
};

// Input data
export interface GetWBSRequest {
  project_code: string;
}

export interface CreateWBSRequest {
  project_code: string;
  wbs_element: string;
  wbs_element_desc: string;
  company_code: string;
  profit_center: string;
}

// Function
export async function getWBS(data: GetWBSRequest): Promise<WBSGetDataResult> {
  console.log('wdr-connect-external getWBS start');
  const SAPLink = process.env.SAP_LINK || '';
  const WBSEndPoint = process.env.SAP_WBS || '';
  const result: WBSGetDataResult = {
    success: false,
    data: [],
    error: ''
  }

  const response = await httpPost<GetWBSResponse>(`${SAPLink}${WBSEndPoint}`, data, {
    headers: await getSAPHeaders()
  });

  if (response.success && response.data) {
    const wbsResultData = response.data;

    switch (wbsResultData.status) {
      case WBSStatusCode.SUCCESS.code:
        result.success = true;
        result.data = wbsResultData.array || [];
        break;
      case WBSStatusCode.NO_WBS.code:
        result.success = true;
        console.log('No WBS found for project code');
        break;
      case WBSStatusCode.FAILED.code:
        console.error('SAP returned failed status for project code');
        result.error = WBSStatusCode.FAILED.message;
        break;
      default:
        console.error('Unexpected status code from SAP:', wbsResultData.status);
        result.error = `Unexpected status code from SAP: ${wbsResultData.status}`;
        break;
    }
  } else {
    console.error('Failed to retrieve WBS from SAP:', `error: ${response.error} and code ${response.status}`);
    result.error = response.error || 'Failed to retrieve WBS from SAP';
  }

  console.log('wdr-connect-external getWBS end');
  return result;
}

export async function createWBS(data: CreateWBSRequest): Promise<WBSCreateDataResult> {
  console.log('wdr-connect-external createWBS start');
  const SAPLink = process.env.SAP_LINK || '';
  const WBSCreateEndPoint = process.env.SAP_CREATE_WBS || '';
  const result: WBSCreateDataResult = {
    success: false,
    data: null,
    error: ''
  }

  const response = await httpPost<CreateWBSResponse>(`${SAPLink}${WBSCreateEndPoint}`, data, {
    headers: await getSAPHeaders()
  });

  if (response.success && response.data) {
    const wbsResultData = response.data;

    switch (wbsResultData.status) {
      case WBSCreateStatusCode.CREATE_SUCCESS.code:
        result.success = true;
        result.data = wbsResultData.data;
        break;
      case WBSCreateStatusCode.DUPLICATE_WBS.code:
        console.error('Duplicate WBS No', wbsResultData.data.wbs_element);
        result.error = WBSCreateStatusCode.DUPLICATE_WBS.message;
        break;
      case WBSCreateStatusCode.CREATE_FAILED.code:
        console.error('SAP returned failed status when create WBS', wbsResultData.data.wbs_element);
        result.error = WBSCreateStatusCode.CREATE_FAILED.message;
        break;
      default:
        console.error('Unexpected status code from SAP when creating WBS:', wbsResultData.status);
        result.error = `Unexpected status code from SAP when creating WBS: ${wbsResultData.status}`;
        break;
    }
  } else {
    console.error('Failed to create WBS from SAP:', `error: ${response.error} and code ${response.status}`);
    result.error = response.error || 'Failed to create WBS from SAP';
  }

  console.log('wdr-connect-external createWBS end');
  return result;
}