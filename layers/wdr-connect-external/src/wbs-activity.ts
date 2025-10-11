import { httpPost, getSAPHeaders } from './connect';

interface CreateActiveResponse {
  array: WBSActiveData[] | WBSActiveData
}

interface WBSActiveData {
  status: number;
  wbs_code: string;
  activity_code: string;
  activity_description: string;
}

export interface WBSActiveCreateTotalResult {
  success: boolean;
  data: WBSActiveCreateResult[];
  error: string | null;
}

interface WBSActiveCreateResult {
  activity_description: string,
  success: boolean,
  message: string
}

export interface CreateActiveRequest {
  array: CreateActiveData[];
}

export interface CreateActiveData {
  wbs_code: string;
  activity_code: string;
  activity_description: string;
}

const WBSCreateActivityCode = {
  CREATE_SUCCESS: { code: 7200, message: 'Success to create activity' },
  DUPLICATE_ACTIVITY_CODE: { code: 7202, message: 'Duplicate activity code' },
  CREATE_FAILED: { code: 7203, message: 'Fail to create activity' }
};

export async function createWBSActive(data: CreateActiveRequest): Promise<WBSActiveCreateTotalResult> {
  console.log('wdr-connect-external createWBSActive start');
  const SAPLink = process.env.SAP_LINK || '';
  const WBSCreateActivityEndPoint = process.env.SAP_CREATE_WBS_ACTIVITY || '';
  const resultData: WBSActiveCreateResult[] = [];
  const errorData: string[] = [];
  let isSuccess = false;

  const response = await httpPost<CreateActiveResponse>(`${SAPLink}${WBSCreateActivityEndPoint}`, data, {
    headers: await getSAPHeaders()
  });

  if (response.success && response.data) {
    const wbsResultData = response.data;
    if (wbsResultData.array) {
      // Handle both single object and array responses
      const items = Array.isArray(wbsResultData.array) ? wbsResultData.array : [wbsResultData.array];
      
      for (const item of items) {
        switch (item.status) {
          case WBSCreateActivityCode.CREATE_SUCCESS.code:
            isSuccess = true;
            resultData.push({ activity_description: item.activity_description, success: true, message: WBSCreateActivityCode.CREATE_SUCCESS.message });
            break;
          case WBSCreateActivityCode.DUPLICATE_ACTIVITY_CODE.code:
            resultData.push({ activity_description: item.activity_description, success: false, message: WBSCreateActivityCode.DUPLICATE_ACTIVITY_CODE.message });
            errorData.push(WBSCreateActivityCode.DUPLICATE_ACTIVITY_CODE.message + ' for ' + item.activity_description);
            break;
          case WBSCreateActivityCode.CREATE_FAILED.code:
            resultData.push({ activity_description: item.activity_description, success: false, message: WBSCreateActivityCode.CREATE_FAILED.message });
            errorData.push(WBSCreateActivityCode.CREATE_FAILED.message + ' for ' + item.activity_description);
            break;
          default:
            console.error('Unexpected status code from SAP when creating activity:', item.status);
            resultData.push({ activity_description: item.activity_description, success: false, message: `Unexpected status code from SAP when creating activity: ${item.status}` });
            errorData.push(`Unexpected status code from SAP when creating activity: ${item.status}`);
            break;
        }
      }
    }
  } else {
    console.error('Failed to create WBS activity from SAP', `error: ${response.error} and code ${response.status}`);
    return { success: false, data: [], error: response.error || 'Failed to create WBS activity from SAP' };
  }

  console.log('wdr-connect-external createWBSActive end');
  // Success if at least one item succeeded, or if no items to process
  return { success: isSuccess || resultData.length === 0, data: resultData, error: errorData.length > 0 ? errorData.join(', ') : null };
}