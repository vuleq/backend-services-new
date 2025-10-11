import { httpPost, HttpResponse, getSAPHeaders } from './connect';

interface ProjectResponse {
  array: ProjectData[];
  status: number;
  total_count: number;
}

// Output data
export interface ProjectGetDataResult {
  success: boolean;
  data: ProjectData[];
  error: string;
}

interface ProjectData {
  project_code: string;
  project_desc: string;
  created_date: string;
  updated_date: string;
}

// Input data
export interface GetProjectRequest {
  array: { project_code: string }[];
}

const ProjectStatusCode = {
  SUCCESS: { code: 6000, message: 'Success to get projects' },
  NO_PROJECTS: { code: 6001, message: 'No projects found' },
  FAILED: { code: 6002, message: 'Failed to get projects' }
};

export async function getProjects(data: GetProjectRequest): Promise<ProjectGetDataResult> {
  console.log('wdr-connect-external getProjects start')
  const SAPLink = process.env.SAP_LINK || '';
  const ProjectEndPoint = process.env.SAP_PROJECT || '';
  const result: ProjectGetDataResult = {
    success: false,
    data: [],
    error: ''
  }

  const headers = await getSAPHeaders();
  console.log('SAP headers:', headers);
  console.log('Request data:', JSON.stringify(data, null, 2));
  console.log('SAPLink:', SAPLink);
  const response = await httpPost<ProjectResponse>(`${SAPLink}${ProjectEndPoint}`, data, {
    headers: headers
  });

  if (response.success && response.data) {
    const projectResultData = response.data;

    console.log('Project data received:', JSON.stringify(projectResultData, null, 2));
    switch (projectResultData.status) {
      case ProjectStatusCode.SUCCESS.code:
        result.success = true;
        result.data = projectResultData.array || [];
        break;
      case ProjectStatusCode.NO_PROJECTS.code:
        result.success = true;
        console.log('No projects found');
        break;
      case ProjectStatusCode.FAILED.code:
        console.error('SAP returned failed status for projects');
        result.error = ProjectStatusCode.FAILED.message;
        break;
      default:
        console.error('Unexpected status code from SAP:', projectResultData.status);
        result.error = `Unexpected status code from SAP: ${projectResultData.status}`;
        break;
    }
  } else {
    console.error('Failed to retrieve projects from SAP:', `error: ${response.error} and code ${response.status}`);
    result.error = response.error || 'Failed to retrieve projects from SAP';
  }

  console.log('wdr-connect-external getProjects end')
  return result;
}