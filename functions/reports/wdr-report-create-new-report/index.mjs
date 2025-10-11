import { executeQuery, performTransaction } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { buildError } from 'wdr-error-codes';
import { isValidCognitoSub, getLoginUserInfo } from 'wdr-common-utils';

const reportType = Object.freeze({
    TEMPLATE: 0,
    HEADER: 1,
    FOOTER: 2,
    REPORT: 3,
    COVER: 4
});

const wdrStatusEnum = {
    'Not started': 0,
    Draft: 1,
    'Pre review': 2,
    'HOD review': 3,
    'SRM review': 4,
    Completed: 5
}

class Report {
    constructor(id, content, header, footer) {
        this.id = id;
        this.content = content;
        this.header = header;
        this.footer = footer;
    }
}

const getReportTemplateById = async (template_id) => {
    if (!template_id) {
        console.error('Error:', "Invalid template Id");
        return undefined;
    }
    try {
        const sql = `SELECT id, content, header_id, header_content, footer_id, footer_content FROM report WHERE id = $1 LIMIT 1`;
        const result = await executeQuery(sql, [template_id]);
        if (!result.data[0]) return undefined;
        return new Report(result.data[0].id, result.data[0].content, {
            id: result.data[0].header_id,
            content: result.data[0].header_content
        }, {
            id: result.data[0].footer_id,
            content: result.data[0].footer_content
        });
    } catch (error) {
        console.error('Error:', error);
        return undefined;
    }
};

const generateDocumentNo = async (subCode, projectId, type) => {
    let documnentNoStr = null;
    let newDocumentNo = null;

    if (type === reportType.REPORT) {
        // SubCode-DocumentNo (from project)
        // const subCodeResult = await executeQuery(`SELECT id FROM sub_codes WHERE sub_no = $1 AND project_id = $2 LIMIT 1`, [subCode, projectId]);
        // if (!subCodeResult.success) throw Error('Error when get sub code data');
        // subId = subCodeResult.data[0]?.id;

        // if (!subId) {
        //     throw Error('Sub code not found');
        // }

        const projectSql = `SELECT tracking_number FROM document_no_tracking WHERE project_id = $1 AND sub_no = $2 LIMIT 1`;
        const projectResult = await executeQuery(projectSql, [projectId, subCode]);

        if (!projectResult.success) throw Error('Error when get document no tracking data');
        if (!projectResult.data) {
            newDocumentNo = 1;
        } else {
            newDocumentNo = (projectResult.data[0]?.tracking_number || 0) + 1;
        }

        documnentNoStr = `${subCode}-${String(newDocumentNo).padStart(2, '0')}`;
    }

    return { documnentNoStr, newDocumentNo };
};

export const handler = async (event) => {
    try {
        console.log('Event:', JSON.stringify(event));
        const requestBody = JSON.parse(event.body) || {};
        const requestHeader = event.headers || {};
        const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

        if (!loginUserId || !isValidCognitoSub(loginUserId)) {
            return new LambdaResponse(400, new ApiResponse(false, null, 'User not logined'));
        }

        console.log(requestBody);


        // Basic validation
        if (!requestBody || Object.keys(requestBody).length === 0) {
            return LambdaResponse.success(buildError('INVALID_REQUEST'));
        }

        // Validate report type
        if (!Object.values(reportType).includes(requestBody.type)) {
            return LambdaResponse.success(buildError('ENTITY_VALIDATION_FAILED', 'Invalid report type'));
        }

        // Required fields validation
        if (requestBody.type === undefined) {
            return LambdaResponse.success(buildError('MISSING_REQUIRED_FIELD', 'Type is required.'));
        }

        // trade_section is not required for HEADER and FOOTER types and COVER types
        if (requestBody.type !== reportType.HEADER && requestBody.type !== reportType.FOOTER && requestBody.type !== reportType.COVER && requestBody.trade_section === undefined) {
            return LambdaResponse.success(buildError('MISSING_REQUIRED_FIELD', 'Trade_section is required for this report type.'));
        }

        if (requestBody.type !== reportType.REPORT && requestBody.name === undefined) {
            return LambdaResponse.success(buildError('MISSING_REQUIRED_FIELD', 'Name is required for this report type.'));
        }

        // Validate required fields for REPORT type
        if (requestBody.type === reportType.REPORT && requestBody.name === undefined) {
            if (requestBody.project_id === undefined || requestBody.sub_code === undefined) {
                return LambdaResponse.success(buildError('MISSING_REQUIRED_FIELD', 'project_id and sub_code are required for REPORT type when name is not provided.'));
            }
        }

        let name = requestBody.name;
        let content = requestBody.content ?? null;
        let header = { id: requestBody.header_id ?? null, content: requestBody.header_content ?? null };
        let footer = { id: requestBody.footer_id ?? null, content: requestBody.footer_content ?? null };

        if (requestBody.type === reportType.REPORT && requestBody.name === undefined) {
            name = requestBody.job_title ?? "Untitled Report";
            // Optionally fetch template content if needed
            if (requestBody.template_id) {
                const template = await getReportTemplateById(requestBody.template_id);
                if (template) {
                    content = template.content;
                    header = { id: template.header.id, content: template.header.content };
                    footer = { id: template.footer.id, content: template.footer.content };
                }
            }
        }

        // Check for unique name (case-sensitive, project_id and trade_section combination)
        if (requestBody.type === reportType.REPORT) {
            const checkNameSql = `SELECT id FROM report WHERE name = $1 AND type = $2 AND project_id = $3 AND trade_section = $4 LIMIT 1`;
            const checkNameParams = [name, requestBody.type, requestBody.project_id, requestBody.trade_section];
            const nameExists = await executeQuery(checkNameSql, checkNameParams);
            if (nameExists.data[0]) {
                return LambdaResponse.success(buildError('RESOURCE_ALREADY_EXISTS', 'Job Title already exists in this project and trade section'));
            }
        } else if (requestBody.type === reportType.TEMPLATE) {
            const checkNameSql = `SELECT id FROM report WHERE name = $1 AND type = $2 AND trade_section = $3 LIMIT 1`;
            const checkNameParams = [name, requestBody.type, requestBody.trade_section];
            const nameExists = await executeQuery(checkNameSql, checkNameParams);
            if (nameExists.data[0]) {
                return LambdaResponse.success(buildError('RESOURCE_ALREADY_EXISTS', 'Report name already exists in this type and trade section'));
            }
        }

        // Only one default template per trade_section and type (REPORT type cannot be default)
        if (requestBody.is_default === true) {
            if (requestBody.type === reportType.REPORT) {
                return LambdaResponse.success(buildError('BUSINESS_RULE_VIOLATION', 'REPORT type cannot be set as default'));
            } else if (requestBody.type === reportType.HEADER || requestBody.type === reportType.FOOTER || requestBody.type === reportType.COVER) {
                // For HEADER, FOOTER, and COVER, check only by type (no trade_section)
                const checkDefaultSql = `SELECT id FROM report WHERE is_default = true AND type = $1 LIMIT 1`;
                const checkDefaultParams = [requestBody.type];
                const defaultExists = await executeQuery(checkDefaultSql, checkDefaultParams);
                if (defaultExists.data[0]) {
                    const typeLabels = {
                        [reportType.HEADER]: 'header',
                        [reportType.FOOTER]: 'footer',
                        [reportType.COVER]: 'cover'
                    };
                    const typeLabel = typeLabels[requestBody.type];
                    
                    // Update existing default to false before creating new default
                    const updateDefaultSql = `UPDATE report SET is_default = false WHERE is_default = true AND type = $1`;
                    await executeQuery(updateDefaultSql, [requestBody.type]);
                    console.log(`Updated existing default ${typeLabel} to non-default`);
                }
            } else {
                // For TEMPLATE type, check by type and trade_section
                const checkDefaultSql = `SELECT id FROM report WHERE is_default = true AND type = $1 AND trade_section = $2 LIMIT 1`;
                const checkDefaultParams = [requestBody.type, requestBody.trade_section];
                const defaultExists = await executeQuery(checkDefaultSql, checkDefaultParams);
                if (defaultExists.data[0]) {
                    // Update existing default to false before creating new default
                    const updateDefaultSql = `UPDATE report SET is_default = false WHERE is_default = true AND type = $1 AND trade_section = $2`;
                    await executeQuery(updateDefaultSql, [requestBody.type, requestBody.trade_section]);
                    console.log(`Updated existing default template for trade_section ${requestBody.trade_section} to non-default`);
                }
            }
        }

        const now = new Date().toISOString();

        const { documnentNoStr, newDocumentNo } = await generateDocumentNo(requestBody.sub_code, requestBody.project_id, requestBody.type);

        const params = [
            name,
            requestBody.trade_section,
            requestBody.type,
            requestBody.type === reportType.REPORT ? false : requestBody.is_default ?? false,
            content,
            requestBody.version ?? null,
            requestBody.parent ?? null,
            requestBody.project_id ?? null,
            requestBody.job_id ?? null,
            now,
            loginUserId,
            now,
            loginUserId,
            requestBody.status ?? null,
            requestBody.awrf_no ?? null,
            requestBody.sub_code ?? null,
            requestBody.approver_id ?? null,
            requestBody.is_published ?? false,
            requestBody.thumbnail ?? null,
            requestBody.template_id ?? null,
            documnentNoStr,
            requestBody.job_title ?? null,
            header?.id ?? null,
            header?.content ?? null,
            footer?.id ?? null,
            footer?.content ?? null
        ];

        const sql = `
            INSERT INTO report (
                name, trade_section, type, is_default, content, version, parent, project_id, job_id,
                created_at, created_by, updated_at, updated_by, status, awrf_no, sub_code, approver_id, is_published, thumbnail, template_id, document_no, job_title,
                header_id, header_content, footer_id, footer_content
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
            )
            RETURNING *
        `;

        const operations = [{
            type: 'query',
            queryText: sql,
            params: params,
            returningClause: '*'
        }];

        if (newDocumentNo) {
            if (newDocumentNo === 1) {
                operations.push({
                    type: 'insert',
                    table: 'document_no_tracking',
                    data: { project_id: requestBody.project_id, sub_no: requestBody.sub_code, tracking_number: newDocumentNo },
                });
            } else {
                operations.push({
                    type: 'update',
                    table: 'document_no_tracking',
                    data: { tracking_number: newDocumentNo },
                    condition: { project_id: requestBody.project_id, sub_no: requestBody.sub_code },
                });
            }
        }

        if (requestBody.type === reportType.REPORT) {
            operations.push({
                type: 'update',
                table: 'jobs',
                data: { wdr_status: wdrStatusEnum['Draft'] },
                condition: { id: requestBody.job_id },
            });
        }

        const result = await performTransaction(operations);

        if (!result.success) {
            console.error('Transaction failed:', result.error);
            return new LambdaResponse(400, buildError('DATABASE_ERROR', result.error || 'Failed to create report'));
        }

        const reportData = result.results?.[0] ? result.results[0][0] : null;

        return LambdaResponse.success(new ApiResponse(true, reportData, 'Report created successfully'));
    } catch (error) {
        console.error('Error:', error);
        return LambdaResponse.success(buildError('DATABASE_ERROR', error.message));
    }
};

