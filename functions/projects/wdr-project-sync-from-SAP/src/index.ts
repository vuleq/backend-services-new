import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { isValidCognitoSub, getLoginUserInfo } from 'wdr-common-utils';
import { getProjects, ProjectGetDataResult, GetProjectRequest, getWBS, WBSGetDataResult, GetWBSRequest } from 'wdr-connect-external';
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

interface SyncResult {
    main_code: string;
    vessel_name: string;
    srm: SRMData[],
    status: "Not Import" | "Already imported";
    created_date: string;
    updated_date: string;
}

interface SRMData {
    id: string;
    name: string;
    email: string;
    error?: string;
}

interface ProjectDataModel {
    main_code: string;
    srm: SRMData[];
}

const roleCodeEnum = {
    'Super User': 'SU',
    'Ship Repair Manager': 'SRM',
    'Safety Officer': 'SO',
    'Commercial Officer Admin': 'COA',
    'Commercial Officer': 'CO',
    Guest: 'GUEST'
};

const roleEnum = {
    'SU': 0,
    'SRM': 1,
    'SO': 2,
    'COA': 3,
    'CO': 4,
    'GUEST': 5
};

const INACTIVE_PREFIX = 'T|';

const PROJECT_CODES = 'PROJECT_CODES';

// Convert ddmmyyyy string to Date
function convertDateString(inputDate: any): Date {
    const dateStr = typeof inputDate === 'string' ? inputDate.trim() : (typeof inputDate === 'number' ? inputDate.toString() : '');
    if (!dateStr || dateStr.length !== 8) {
        throw new Error('Invalid date string format, expected ddmmyyyy');
    }
    const day = dateStr.substring(0, 2);
    const month = dateStr.substring(2, 4);
    const year = dateStr.substring(4, 8);
    return new Date(`${year}-${month}-${day}`);
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // Sanitize event data for logging
        const sanitizedEvent = {
            httpMethod: event.httpMethod,
            path: event.path,
            queryStringParameters: event.queryStringParameters,
            headers: event.headers ? Object.keys(event.headers) : []
        };
        console.log('Received event:', JSON.stringify(sanitizedEvent, null, 2));

        // Get user information from Cognito claims
        const requestHeader = event.headers;
        const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

        if (!loginUserId || !isValidCognitoSub(loginUserId)) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid user ID format'));
        }

        const projectCodesResult = await executeQuery(`SELECT value FROM app_settings WHERE code = $1`, [PROJECT_CODES]);
        if (!projectCodesResult.success || projectCodesResult.data.length === 0) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'Project codes not found in app settings'));
        }

        // value is list of prefix of project code split by |
        const projectCodeList: string[] = projectCodesResult.data[0].value.split('|').map((code: string) => code.trim());
        if (projectCodeList.length === 0) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'Project codes not found in app settings'));
        }

        const syncResult: SyncResult[] = [];
        let foundAnyProject = false;
        const error: string[] = []
        let newProjectCount = 0;

        for (const projectCode of projectCodeList) {
            try {
                const requestBody: GetProjectRequest = {
                    array: [{ project_code: projectCode + '*' }]
                };

                const resultDatas: ProjectGetDataResult = await getProjects(requestBody);
                if (!resultDatas.success) {
                    console.error('Failed to get projects from SAP:', resultDatas.error);
                    error.push(resultDatas.error);
                    continue; // Skip this code, continue with others
                }

                foundAnyProject = true;
                const projectDatas = Array.isArray(resultDatas.data) ? resultDatas.data : [];
                const projectCodes = projectDatas.map(data => data.project_code);
                console.log('Project codes count:', projectCodes.length);

                const checkProjectsResult = await checkProject(projectCodes);

                // Collect all unique SRM emails needed for WBS processing and map per project
                const requiredSrmEmails = new Set<string>();
                const projectWbsSrmMap: Record<string, Set<string>> = {};

                for (const project of projectDatas) {
                    try {
                        const wbsRequest: GetWBSRequest = {
                            project_code: project.project_code
                        };
                        const wbsResultData: WBSGetDataResult = await getWBS(wbsRequest);

                        if (!wbsResultData.success) {
                            console.error('Failed to get WBS from SAP:', wbsResultData.error);
                            continue; // Skip this code, continue with others
                        }

                        const wbsResult = wbsResultData.data || [];
                        console.log('WBS count:', wbsResult.length);
                        wbsResult.forEach(data => {
                            if (data.srm) {
                                const srmEmail = data.srm.startsWith(INACTIVE_PREFIX) ? data.srm.substring(INACTIVE_PREFIX.length) : data.srm;
                                requiredSrmEmails.add(srmEmail);
                                if (!projectWbsSrmMap[project.project_code]) {
                                    projectWbsSrmMap[project.project_code] = new Set<string>();
                                }
                                projectWbsSrmMap[project.project_code].add(srmEmail);
                            }
                        });
                    } catch (wbsErr) {
                        console.error(`Exception in WBS fetch for project ${project.project_code}:`, wbsErr);
                        continue;
                    }
                }

                // Only fetch SRM users that are actually needed
                console.log('Required SRM emails:', Array.from(requiredSrmEmails));
                const requiredSRM = requiredSrmEmails.size > 0 ? await getSRMByEmails(Array.from(requiredSrmEmails)) : [];

                projectDatas.forEach(project => {
                    const existingProject = checkProjectsResult.find(p => p.main_code === project.project_code);
                    let srmData: SRMData[] = [];

                    if (existingProject) {
                        srmData = existingProject.srm;
                    } else {
                        newProjectCount++;
                        // Only assign SRMs that match the WBS SRM for this project
                        const wbsSrmEmails = projectWbsSrmMap[project.project_code] ? Array.from(projectWbsSrmMap[project.project_code]) : [];
                        const wbsSrms = requiredSRM.filter(srm => wbsSrmEmails.includes(srm.email));

                        if (wbsSrms.length > 0) {
                            srmData = wbsSrms;
                        } else {
                            // Create entries for SRM emails that don't exist in system
                            srmData = wbsSrmEmails.map(email => ({
                                id: '',
                                name: '',
                                email: email,
                                error: 'SRM not found in system'
                            }));
                        }
                    }

                    let createdDate = '';
                    let updatedDate = '';

                    try {
                        createdDate = convertDateString(project.created_date).toISOString();
                    } catch (e) {
                        createdDate = '';
                    }

                    try {
                        updatedDate = convertDateString(project.updated_date).toISOString();
                    } catch (e) {
                        updatedDate = '';
                    }

                    syncResult.push({
                        main_code: project.project_code,
                        vessel_name: project.project_desc,
                        srm: srmData,
                        status: existingProject ? 'Already imported' : 'Not Import',
                        created_date: createdDate,
                        updated_date: updatedDate
                    });
                });
            } catch (err) {
                console.error(`Exception in processing project code ${projectCode}:`, err);
                continue;
            }
        }

        if (!foundAnyProject) {
            return new LambdaResponse(error.length > 0 ? 400 : 200, new ApiResponse(error.length > 0 ? false : true, [], error.length > 0 ? error.join(', ') : 'No projects found'));
        }

        await executeQuery(`UPDATE project_temp SET new_project_count = $1, status = $2, error = $3`,
            [newProjectCount, error.length === 0, error.join(', ')]);

        // Sort: "Not Import" status first, then by creation date (oldest first)
        syncResult.sort((a, b) => {
            if (a.status !== b.status) {
                return a.status === 'Not Import' ? -1 : 1;
            }
            return new Date(a.created_date).getTime() - new Date(b.created_date).getTime();
        });

        return new LambdaResponse(200, new ApiResponse(true, syncResult));
    } catch (error: any) {
        console.error('Error:', error);
        return new LambdaResponse(400, new ApiResponse(false, null, 'Project sync failed: ' + error.message || 'An unexpected error occurred'));
    }
};

async function checkProject(projectCodes: string[]): Promise<ProjectDataModel[]> {
    const baseQuery = `SELECT p.main_code, u.id, u.name, u.email 
    FROM projects p 
    JOIN project_assignments pa ON pa.project_id = p.id 
    JOIN users u ON u.id = pa.user_id 
    WHERE p.main_code = ANY($1) AND pa.role = $2`;

    const result = await executeQuery(baseQuery, [projectCodes, roleEnum.SRM]);
    if (!result.success) {
        throw new Error('Failed to get user data');
    }

    const projectMap = new Map<string, ProjectDataModel>();

    result.data.forEach((row: any) => {
        if (!projectMap.has(row.main_code)) {
            projectMap.set(row.main_code, {
                main_code: row.main_code,
                srm: []
            });
        }
        const project = projectMap.get(row.main_code);
        if (project) {
            project.srm.push({
                id: row.id,
                name: row.name,
                email: row.email
            });
        }
    });

    return Array.from(projectMap.values());
}

async function getSRMByEmails(emails: string[]): Promise<SRMData[]> {
    const query = `SELECT u.id, u.name, u.email
    FROM users u 
    JOIN user_roles ur ON ur.user_id = u.id 
    JOIN roles r ON r.id = ur.role_id 
    WHERE r.code = $1 AND u.email = ANY($2)`;
    const result = await executeQuery(query, [roleCodeEnum['Ship Repair Manager'], emails]);

    if (!result.success) {
        throw new Error('Failed to get SRM users');
    }

    return result.data.map((row: any) => ({
        id: row.id,
        name: row.name,
        email: row.email
    }));
}