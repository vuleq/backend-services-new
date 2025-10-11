import { executeQuery, performTransaction, Operation } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { isValidCognitoSub, isValidUUID, getLoginUserInfo } from 'wdr-common-utils';
import { getWBS, GetWBSRequest, WBSGetDataResult } from 'wdr-connect-external';
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

interface SubCodeCreateModel {
    sub_no: string;
    wbs_element: string; // Added to store WBS element
    description: string;
    project_id: string;
    created_by: string;
    updated_by: string;
    created_at: Date;
    updated_at: Date;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('Receive event', JSON.stringify(event, null, 2));

    try {
        // Get user information from Cognito claims
        const requestHeader = event.headers;
        const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

        if (!loginUserId || !isValidCognitoSub(loginUserId)) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid user ID format'));
        }

        const projectId = event.pathParameters?.id;

        if (!projectId || !isValidUUID(projectId)) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'Invalid project ID format'));
        }

        const projectResult = await executeQuery(`SELECT main_code FROM projects WHERE id = $1`, [projectId]);

        if (!projectResult.success) {
            return new LambdaResponse(404, new ApiResponse(false, null, 'Error when get project data'));
        }

        if (projectResult.rowCount === 0) {
            return new LambdaResponse(404, new ApiResponse(false, null, 'Project not found'));
        }

        const mainCode = projectResult.data[0].main_code;

        const wbsRequest: GetWBSRequest = {
            project_code: mainCode
        };

        const wbsResultData: WBSGetDataResult = await getWBS(wbsRequest);

        if (!wbsResultData.success) {
            return new LambdaResponse(500, new ApiResponse(false, null, wbsResultData.error));
        }

        const wbsResult = wbsResultData.data || [];
        console.log('WBS count:', wbsResult.length);

        const subCodeSyncs = wbsResult.map((wbs) => wbs.wbs_element);
        const existSubCodes = await executeQuery(`SELECT wbs_element FROM sub_codes WHERE project_id = $1 and wbs_element = ANY($2)`, [projectId, subCodeSyncs]);
        console.log('Existing Sub Codes count:', existSubCodes.rowCount);
        const existingSubCodesSet = new Set(existSubCodes.data.map((row: any) => row.wbs_element));
        const newSubCodes = wbsResult.filter((wbs) => !existingSubCodesSet.has(wbs.wbs_element));

        if (newSubCodes.length === 0) {
            console.log('No new sub codes to create');
            return new LambdaResponse(200, new ApiResponse(true, null, 'Sync WBS from SAP successfully', null));
        }

        const currentTime = new Date();
        const subCodeData: SubCodeCreateModel[] = newSubCodes.map((wbs) => ({
            sub_no: wbs.wbs_element.split('.').reverse()[0],
            wbs_element: wbs.wbs_element,
            description: wbs.wbs_element_desc,
            project_id: projectId,
            created_by: loginUserId,
            updated_by: loginUserId,
            created_at: currentTime,
            updated_at: currentTime
        }));

        // Create batch operations for transaction
        const BATCH_SIZE = 1000;
        const columns = ['sub_no', 'wbs_element', 'description', 'project_id', 'created_by', 'updated_by', 'created_at', 'updated_at'];
        const operations: Operation[] = [];

        for (let i = 0; i < subCodeData.length; i += BATCH_SIZE) {
            const batch = subCodeData.slice(i, i + BATCH_SIZE);

            const values = batch.map((_, index) =>
                `(${columns.map((_, colIndex) => `$${index * columns.length + colIndex + 1}`).join(', ')})`
            ).join(', ');

            const flatValues = batch.flatMap(data => [
                data.sub_no, data.wbs_element, data.description, data.project_id,
                data.created_by, data.updated_by, data.created_at, data.updated_at
            ]);

            operations.push({
                type: 'query',
                queryText: `INSERT INTO sub_codes (${columns.join(', ')}) VALUES ${values} RETURNING *`,
                params: flatValues
            });
        }

        const txResult = await performTransaction(operations);
        if (!txResult.success) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'Error when adding sub code'));
        }

        const allResults = txResult.results?.flat() || [];
        console.log('Transaction completed successfully, rows affected:', allResults.length);
        return new LambdaResponse(200, new ApiResponse(true, allResults, `Sync WBS from SAP successfully`, null));

    } catch (error: any) {
        console.error('Error:', error);
        return new LambdaResponse(400, new ApiResponse(false, null, 'Sub code sync failed: ' + error.message || 'An unexpected error occurred'));
    }
};
