import { executeQuery, performTransaction, Operation } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { isValidUUID, isValidCognitoSub, getLoginUserInfo } from 'wdr-common-utils';
import { createWBS, CreateWBSRequest, createWBSActive, CreateActiveRequest, CreateActiveData } from 'wdr-connect-external';
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

interface SubCodeCreateModel {
    sub_no: string;
    wbs_element: string;
    description: string;
    project_id: string;
    created_by: string;
    updated_by: string;
    created_at: Date;
    updated_at: Date;
}

interface ActivityInputModel {
    code: string;
    tradeSectionId: string;
}

interface CompanySettings {
    company_code: string;
    profit_center: string;
}

interface TradeSectionMap {
    id: string;
    name: string;
}

enum ProjectRole {
    SU = 0,
    SRM
}

const ENTITY_CODE = 'ENTITY_CODE';
const COMPANY_CODE = 'COMPANY_CODE';

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('Receive event', JSON.stringify(event, null, 2));

    try {
        // Get user information from Cognito claims
        const requestHeader = event.headers;
        const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

        if (!loginUserId || !isValidCognitoSub(loginUserId)) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid user ID format'));
        }

        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
        const now = new Date();
        const subCodeData: SubCodeCreateModel = {
            sub_no: body.subNo,
            description: body.description,
            project_id: body.projectId,
            created_by: loginUserId,
            updated_by: loginUserId,
            created_at: now,
            updated_at: now,
            wbs_element: ''
        };

        const hasAccess = await isUserAllowToCreateWBS(loginUserId, subCodeData.project_id);
        if (!hasAccess) {
            return new LambdaResponse(403, new ApiResponse(false, null, 'User do not has permission to create job'));
        }

        // Array of UUID
        let activities: ActivityInputModel[] = body.activities;

        validateInput(subCodeData, activities);

        const { projectCode, wbsElement } = await createWBSElement(subCodeData);

        await validateWBSElement(wbsElement, subCodeData.project_id);

        subCodeData.wbs_element = wbsElement;

        const tradeSectionMap: TradeSectionMap[] = await validateTradeSection(activities);

        activities = await createWBSInSAP(activities, tradeSectionMap, subCodeData, projectCode);

        // Add bulk insert for trade sections
        const tradeSectionValues = activities.map((_, index) => `($${index * 2 + 2}, $1, $${index * 2 + 3})`).join(', ');
        const bulkInsertQuery = `INSERT INTO trade_section_sub_code (trade_section_id, sub_code_id, code) VALUES ${tradeSectionValues}`;

        const operations: Operation[] = [{
            type: 'insert',
            table: 'sub_codes',
            data: subCodeData,
            returningClause: '*'
        }];

        operations.push({
            type: 'query',
            queryText: bulkInsertQuery,
            params: [{
                type: 'dynamic_result',
                fromIndex: 0,
                field: 'id'
            }, ...activities.flatMap(a => [a.tradeSectionId, a.code])]
        });

        const txResult = await performTransaction(operations);
        if (!txResult.success) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'Error when adding sub code'));
        }
        return new LambdaResponse(200, new ApiResponse(true, txResult.results?.[0][0], 'Sub code created successfully', null));

    } catch (error: any) {
        console.error('Error:', error);
        return new LambdaResponse(400, new ApiResponse(false, null, 'Sub code created failed: ' + error.message || 'An unexpected error occurred'));
    }
};

async function isUserAllowToCreateWBS(userId: string, projectId: string) {
    // Only Super User and SRM can create WBS
    const checkProjectRoleResult = await executeQuery(
        `SELECT EXISTS (SELECT 1 FROM project_assignments pa WHERE pa.user_id = $1 AND pa.project_id = $2 AND pa.role = ANY($3))`,
        [userId, projectId, [ProjectRole.SU, ProjectRole.SRM]]
    );

    if (!checkProjectRoleResult.success) {
        console.error('Failed to check project role');
        return false;
    }

    return checkProjectRoleResult.data[0].exists;
}

async function validateInput(subCodeData: SubCodeCreateModel, activities: ActivityInputModel[]) {
    if (!subCodeData.project_id) {
        throw new Error('Project ID is required');
    }

    if (!isValidUUID(subCodeData.project_id)) {
        throw new Error('Invalid project ID format');
    }

    if (!subCodeData.sub_no) {
        throw new Error('Sub no is required');
    }

    if (!subCodeData.description) {
        throw new Error('Description is required');
    }

    if (!activities || !Array.isArray(activities) || activities.length === 0) {
        throw new Error('Activities is required');
    }
}

async function validateTradeSection(activities: ActivityInputModel[]) {
    for (let i = 0; i < activities.length; i++) {
        if (!activities[i].code || !activities[i].tradeSectionId) {
            throw new Error(`Missing required fields in activity at index ${i}`);
        }
        if (!isValidUUID(activities[i].tradeSectionId)) {
            throw new Error(`Invalid trade section id at index ${i}`);
        }
    }

    const tradeSectionIds = activities.map(item => item.tradeSectionId);
    const tradeSectionResult = await executeQuery(`SELECT id, name FROM trade_sections WHERE id = ANY($1)`, [tradeSectionIds]);
    if (!tradeSectionResult.success) {
        throw new Error('Error when fetching trade section');
    }

    const tradeSectionMap: TradeSectionMap[] = tradeSectionResult.data;
    if (tradeSectionResult.data.length != tradeSectionIds.length) {
        const validTradeIds = tradeSectionMap.map(item => item.id);
        const invalidTrades = tradeSectionIds.filter(item => !validTradeIds.includes(item))
        throw new Error(`Trade section not found for ids: ${invalidTrades.join(', ')}`);
    }

    return tradeSectionMap;
}

async function createWBSInSAP(activities: ActivityInputModel[], tradeSectionMap: TradeSectionMap[], subCodeData: SubCodeCreateModel, projectCode: string) {
    let companySettings: CompanySettings[] = await getCompanySetting();
    let addWBSSuccess = false;

    for (let index = 0; index < companySettings.length; index++) {
        const element = companySettings[index];
        const wbsCreateData: CreateWBSRequest = {
            wbs_element: subCodeData.wbs_element,
            wbs_element_desc: subCodeData.description,
            project_code: projectCode,
            company_code: element.company_code,
            profit_center: element.profit_center
        };

        const createWBSResponse = await createWBS(wbsCreateData);
        if (!createWBSResponse.success) {
            console.error('Failed to create WBS for company code:', element.company_code, createWBSResponse.error);
            continue;
        }

        addWBSSuccess = true;

        const createActivityData: CreateActiveData[] = activities.map(item => {
            const tradeMap = tradeSectionMap.find(trade => trade.id === item.tradeSectionId)!;
            return {
                wbs_code: subCodeData.wbs_element,
                activity_code: item.code,
                activity_description: tradeMap.name.toUpperCase()
            };
        });

        const createActivityRequest: CreateActiveRequest = {
            array: createActivityData
        };

        const createActivityResponse = await createWBSActive(createActivityRequest);
        if (!createActivityResponse.success) {
            console.error('Failed to create WBS activity:', createActivityResponse.error);
            throw new Error('Failed to create WBS activity in SAP ');
        } else {
            const errorActivities = createActivityResponse.data.filter(item => !item.success);
            if (errorActivities.length > 0) {
                const addFailedActivityNames = errorActivities.map(item => item.activity_description);
                const addFailedActivities = tradeSectionMap.filter(item => addFailedActivityNames.includes(item.name));
                const addFailedActivityIds = addFailedActivities.map(item => item.id);
                console.error('Failed to create WBS activities:', (errorActivities.map(item => item.message)).join(', '));
                activities = activities.filter(item => !addFailedActivityIds.includes(item.tradeSectionId));
            }
        }
        break;
    }

    // Not create wbs success then throw error
    if (!addWBSSuccess) {
        console.log(`Failed to create WBS in SAP for all company codes`);
        throw new Error('Failed to create WBS in SAP for all company codes');
    }

    return activities;
}

async function getCompanySetting() {
    const companyCodeResult = await executeQuery(`SELECT value FROM app_settings WHERE code = $1`, [COMPANY_CODE]);

    if (!companyCodeResult.success) {
        throw new Error('Error when fetching company data');
    }

    if (!companyCodeResult.data?.[0]?.value) {
        throw new Error('Not found company data');
    }

    let companySettings: CompanySettings[];
    try {
        companySettings = JSON.parse(companyCodeResult.data[0].value);
    } catch (parseError) {
        throw new Error('Invalid company settings format');
    }

    return companySettings;
}

async function createWBSElement(subCodeData: SubCodeCreateModel) {
    const mainCodeAndEntityCodeResult = await executeQuery(`SELECT 
                (SELECT main_code FROM projects WHERE id = $1) AS project_code,
                (SELECT value FROM app_settings WHERE code = $2) AS entity_code;`, [subCodeData.project_id, ENTITY_CODE]);

    if (!mainCodeAndEntityCodeResult.success) {
        throw new Error('Error when fetching main code and entity code');
    }

    const mainCodeAndEntityCode = mainCodeAndEntityCodeResult.data?.[0];
    const projectCode = mainCodeAndEntityCode?.project_code;
    const entityCode = mainCodeAndEntityCode?.entity_code;

    if (!projectCode) {
        throw new Error('Project main code not found');
    }

    if (!entityCode) {
        throw new Error('Entity code not found');
    }

    return { projectCode: projectCode, wbsElement: `${projectCode}.${entityCode}.${subCodeData.sub_no}` };
}

async function validateWBSElement(wbsElement: string, projectId: string) {
    const sql = `SELECT EXISTS (SELECT 1 FROM sub_codes WHERE wbs_element = $1 AND project_id = $2)`;
    const params = [wbsElement, projectId];
    const subcodeSearchResult = await executeQuery(sql, params);

    if (!subcodeSearchResult.success) {
        throw new Error('Error when searching sub code');
    }

    const result = subcodeSearchResult.data[0];
    if (result.exists) {
        throw new Error('Sub code already exists');
    }
}