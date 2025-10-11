import { executeQuery } from 'wdr-connect-db';
import { getProjects, GetProjectRequest, ProjectGetDataResult, HttpResponse } from 'wdr-connect-external';
import { Handler, EventBridgeEvent } from 'aws-lambda';

const PROJECT_CODES = 'PROJECT_CODES';

export const handler: Handler = async (event: EventBridgeEvent<string, any>): Promise<void> => {
    try {
        console.log('Received event:', JSON.stringify(event, null, 2));

        let newProjectCount = 0;
        let error: string[] = [];

        const projectCodesResult = await executeQuery(`SELECT value FROM app_settings WHERE code = $1`, [PROJECT_CODES]);
        if (!projectCodesResult.success || projectCodesResult.data.length === 0) {
            error.push('Project codes not found in app settings');
            await executeQuery(`UPDATE project_temp SET new_project_count = $1, status = $2, error = $3`,
                [0, false, error.join(', ')]);
            return;
        }

        // value is list of prefix of project code split by |
        const projectCodeList: string[] = projectCodesResult.data[0].value.split('|').map((code: string) => code.trim());
        if (projectCodeList.length === 0) {
            error.push('Project codes not found in app settings');
            await executeQuery(`UPDATE project_temp SET new_project_count = $1, status = $2, error = $3`,
                [0, false, error.join(', ')]);
            return;
        }

        for (const projectCode of projectCodeList) {
            try {
                const requestBody: GetProjectRequest = {
                    array: [{ project_code: projectCode + '*' }]
                };

                const resultDatas: ProjectGetDataResult = await getProjects(requestBody);
                if (!resultDatas.success) {
                    error.push(`Failed to get projects from SAP with project code: ${projectCode}`);
                    continue; // Skip this code, continue with others
                }

                const projectDatas = Array.isArray(resultDatas.data) ? resultDatas.data : [];
                const projectCodes = projectDatas.map(data => data.project_code);
                console.log('Project codes count:', projectCodes.length);

                const projectCount = await checkProject(projectCodes);
                newProjectCount += projectCount;
            } catch (err) {
                console.error(`Exception in processing project code ${projectCode}:`, err);
                error.push(`Exception in processing project code ${projectCode}`);
                continue;
            }
        }

        const updateResult = await executeQuery(`UPDATE project_temp SET new_project_count = $1, status = $2, error = $3`,
            [newProjectCount, error.length === 0, error.join(', ')]);
        console.log('Daily fetch completed successfully. New projects:', newProjectCount);
    } catch (error: any) {
        console.error('Error:', error);
        throw error;
    }
};

async function checkProject(projectCodes: string[]): Promise<number> {
    const baseQuery = `SELECT COUNT(main_code) as existed FROM projects WHERE main_code = ANY($1)`;

    const result = await executeQuery(baseQuery, [projectCodes]);
    if (!result.success) {
        throw new Error('Failed to get project data');
    }

    const existed = result.data ? Number(result.data[0].existed) : 0;

    return projectCodes.length - existed;
}